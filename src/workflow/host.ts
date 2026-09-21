/**
 * host.ts — binds a workflow run to the pi-herdr spawn machinery.
 *
 * This file is OURS (v0.6 issue 12, ~the "host seam" half of the workflow
 * ticket): `runtime.ts` deliberately knows nothing about herdr — its only seam
 * is the injected {@link WorkflowHost}, which is what keeps the runtime's tests
 * free of panes, settings and sessions. Everything the script can reach through
 * `agent()`, `resume` and `gate` ends up here.
 *
 * The mappings (issue 12's option table):
 *
 *   - **handles.** The runtime hands out `wf-agent-N` ids for its progress
 *     entries; the spawn engine issues the pane handle. `handles` translates,
 *     for the whole run — `resume` reaches back to a child that has already
 *     finished, and `abortAgent` runs after the handle exists.
 *   - **type/kind.** `agentType` resolves through the `.md` registry (the same
 *     dispatch herdr_spawn_agent uses, `general-purpose` by default); the KIND
 *     is pinned to `pi` — the v0.6 ruling: workflow children ride the session
 *     substrate (JSONL result, sidecar, resume), which is pi-only.
 *   - **model/effort.** `model` and `effort` (→ `thinking`) ride the spawn
 *     engine's routing chain at level 1 — exact authenticated `provider/model-id`
 *     or the spawn refuses, naming the level. A refusal is THIS agent's failure
 *     (the script sees null), not the run's — upstream's ruling.
 *   - **isolation.** `isolation: "worktree"` → the engine's `isolated` (herdr-side
 *     auto worktree). A gate then runs against the worktree the child wrote.
 *   - **completion.** The 06 push machinery IS the completion callback: the host
 *     awaits `getAgentResult` — the same sidecar → JSONL → gone detection the
 *     push loop reads. A BLOCKED child keeps the call waiting (decided): the
 *     delivery loop's blocked wake lands, and an answer via herdr_message_agent
 *     resumes the child.
 *   - **children report to the run, not the session.** Each spawned record is
 *     stamped with the run id; the delivery loop suppresses per-child terminal
 *     pushes for stamped records. The run itself pushes once, aggregated.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { herdr } from "../herdr.js";
import {
	spawnAgent as spawnEngineAgent,
	spawnRecords,
	type SpawnRecord,
	type SpawnDeps,
} from "../spawn.js";
import {
	defaultAgentDirs,
	resolveSpecifier,
	type AgentDirs,
} from "../agentdefs.js";
import { getAgentResult, type ResultView } from "../tools/result.js";
import { resumeAgent as resumeMachinery } from "../tools/lifecycle.js";
import type { RoutingRegistry } from "../launchplan.js";
import {
	type WorkflowGateResult,
	type WorkflowHost,
	type WorkflowSpawnRequest,
	type WorkflowSpawnResult,
} from "./runtime.js";

/** Wall-clock bound on a `gate` command. Generous — a gate is routinely a test
 * suite — but not unbounded: a gate that hangs forever would wedge the agent
 * slot it is holding. */
export const DEFAULT_GATE_TIMEOUT_MS = 10 * 60_000;

/** How often a blocked child is re-polled while its agent() call waits. */
const BLOCK_POLL_MS = 1_500;

export interface WorkflowHostDeps {
	pi: ExtensionAPI;
	/** This session's pi context: routing level 5 (parent model) + exact-model
	 * validation registry. */
	ctx?: ExtensionContext;
	/** The run's abort signal, so killing the run stops tracking its children. */
	signal?: AbortSignal;
	/** The run id every child record is stamped with (`SpawnRecord.workflow`). */
	runId: string;
	gateTimeoutMs?: number;

	// ---- injectable seams (offline red-green; defaults hit herdr + disk) ----
	/** The spawn engine — default: src/spawn.ts spawnAgent. */
	spawn?: typeof spawnEngineAgent;
	/** The completion reader — default: src/tools/result.ts getAgentResult. */
	result?: typeof getAgentResult;
	/** The resume machinery — default: src/tools/lifecycle.ts resumeAgent. */
	resume?: typeof resumeMachinery;
	/** Pane close (abort) — default: `herdr pane close` (session retained). */
	closePane?: (paneId: string) => Promise<unknown>;
	/** Gate command runner — default: pi.exec under a platform shell. */
	exec?: (command: string, cwd: string) => Promise<WorkflowGateResult>;
	/** The spawn registry — default: the LIVE spawnRecords(). */
	records?: () => ReadonlyMap<string, SpawnRecord>;
	/** `.md` registry folders (type resolution for the pi-kind refusal) —
	 * default: `<cwd>/.pi/agents` + the global agents dir. */
	agentDirs?: AgentDirs;
}

/** Shell used to run a `gate` command, mirroring how a user would type it. */
const GATE_SHELL: readonly [string, string] =
	process.platform === "win32" ? ["cmd", "/c"] : ["sh", "-c"];

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function createWorkflowHost(deps: WorkflowHostDeps): WorkflowHost {
	/** Runtime agent id (`wf-agent-N`) → the spawn handle (pane name). Kept for
	 * the whole run: `resume` reaches a child that has already settled. */
	const handles = new Map<string, string>();
	const records = deps.records ?? spawnRecords;

	/** The engine deps every spawn/resume carries: this session's routing
	 * context plus the run's abort signal. */
	function engineDeps(): SpawnDeps {
		return {
			signal: deps.signal,
			parent: deps.ctx?.model
				? { model: { provider: deps.ctx.model.provider, id: deps.ctx.model.id } }
				: undefined,
			registry: deps.ctx?.modelRegistry as RoutingRegistry | undefined,
		};
	}

	/**
	 * Await one child's completion through the 06 detection machinery — the
	 * same sidecar → JSONL → gone evidence the push loop reads.
	 *
	 * `blocked` keeps WAITING (decided): the delivery loop has woken the
	 * orchestrator, whose model or human can answer via herdr_message_agent;
	 * the child then returns to work and this loop sees the settle.
	 */
	async function awaitSettled(handle: string): Promise<WorkflowSpawnResult> {
		for (;;) {
			const r = await (deps.result ?? getAgentResult)(
				{ target: handle, wait: true },
				{ signal: deps.signal },
			);
			if (!r.ok) {
				return { ok: false, error: r.error.message === "aborted" ? "aborted" : r.error.message };
			}
			const v: ResultView = r.data;
			if (v.status === "done") return { ok: true, text: v.result ?? "" };
			if (v.status === "error") {
				const msg = v.error?.errorMessage ?? "child failed";
				return { ok: false, error: v.error?.stopReason ? `${v.error.stopReason}: ${msg}` : msg };
			}
			if (v.status === "blocked") {
				await sleep(BLOCK_POLL_MS);
				continue;
			}
			// gone: no live pane and no completion on disk. The session file stays
			// readable/resumable — say so, since the run is abandoning the child.
			return {
				ok: false,
				error: `the pane is gone without completing${v.note ? ` (${v.note})` : ""}`,
			};
		}
	}

	return {
		async spawnAgent(request: WorkflowSpawnRequest): Promise<WorkflowSpawnResult> {
			// Workflow children are pi-only (v0.6 substrate ruling): the kind is
			// pinned to pi, and a definition whose OWN kind names a non-pi CLI is a
			// per-agent refusal — coerced children would run the wrong harness
			// silently. `general-purpose` (unset kind) always passes.
			const resolved = resolveSpecifier(
						{ type: request.agentType || "general-purpose" },
						deps.agentDirs ?? defaultAgentDirs(),
			);
			if (!resolved.ok) return { ok: false, error: resolved.error.message };
			const defKind = resolved.data.definition.kind;
			if (defKind !== undefined && defKind.toLowerCase() !== "pi") {
						return {
								ok: false,
								error: `agentType "${resolved.data.definition.name}" is kind "${defKind}" — workflow children are pi-only (the result contract rides the pi session substrate)`,
						};
			}
			// Kind pinned at the host: no default_kind drift can put a workflow
			// child on a non-pi harness.
			const r = await (deps.spawn ?? spawnEngineAgent)(
				{
					prompt: request.prompt,
					type: request.agentType || "general-purpose",
					kind: "pi",
					...(request.model !== undefined ? { model: request.model } : {}),
					...(request.effort !== undefined ? { thinking: request.effort } : {}),
					...(request.isolation === "worktree" ? { isolated: true } : {}),
					name: request.label,
					wait: false,
				},
				engineDeps(),
			);
			if (!r.ok) {
				// A routing/enforcement refusal (bad model id, unknown type, gate…
				// named level included) is THIS agent's failure — the script sees
				// null and its siblings carry on. Upstream's ruling.
				return { ok: false, error: r.error.message };
			}
			const handle = r.data.name;
			handles.set(request.agentId, handle);
			// The record exists the moment the engine accepts the spawn (queued
			// included): stamp the run id before anything can watch it, so the
			// delivery loop never pushes a per-child completion.
			const rec = records().get(handle);
			if (rec) rec.workflow = deps.runId;
			request.onResolved?.({ recordId: handle });
			return awaitSettled(handle);
		},

		abortAgent(agentId) {
			const handle = handles.get(agentId);
			if (handle === undefined) return;
			const rec = records().get(handle);
			if (!rec) return;
			if (!rec.paneId) {
				// Still queued (no pane yet): nothing to close, and the drain loop
				// must never start it for a run that is over. Marking it failed is
				// the honest terminal — status reads gone with the reason.
				rec.startError = `the workflow run (${deps.runId}) ended before this child started`;
				return;
			}
			// Best-effort pane close — the kill-all path. Sessions are never
			// deleted: the child stays resumable, its record reads gone.
			void (deps.closePane ?? ((paneId: string) =>
				herdr(["pane", "close", paneId], { timeoutMs: 10_000 })))(rec.paneId).catch(
				() => {},
			);
		},

		async resumeAgent(agentId, prompt, onResolved) {
			const handle = handles.get(agentId);
			if (handle === undefined) {
				return { ok: false, error: `Cannot resume "${agentId}" — it never started.` };
			}
			onResolved?.({ recordId: handle });
			// The 10 machinery: registry handle → gone-check → re-derived launch
			// plan (NOW) → gates → fresh run on the same retained session. Same
			// gates as any spawn (cap/queue/kill-switch).
			const r = await (deps.resume ?? resumeMachinery)(
				{ target: handle, message: prompt },
				engineDeps(),
			);
			if (!r.ok) return { ok: false, error: r.error.message };
			return awaitSettled(handle);
		},

		/**
		 * Run a `gate` command against the tree the child actually wrote: its
		 * worktree when isolated, its cwd otherwise. A failing command becomes
		 * the agent's typed failure (applyGate shapes it runtime-side).
		 */
		async runGate(command, gate) {
			const handle = handles.get(gate.agentId);
			const rec = handle !== undefined ? records().get(handle) : undefined;
			const cwd = rec?.worktreePath ?? rec?.cwd ?? process.cwd();
			if (deps.exec) return deps.exec(command, cwd);
			const result = await deps.pi.exec(GATE_SHELL[0], [GATE_SHELL[1], command], {
				cwd,
				timeout: deps.gateTimeoutMs ?? DEFAULT_GATE_TIMEOUT_MS,
				...(deps.signal !== undefined ? { signal: deps.signal } : {}),
			});
			const output = [result.stdout, result.stderr]
				.map((stream) => stream.trim())
				.filter(Boolean)
				.join("\n");
			// A timeout reports as `killed` (often with code 0) — the code alone
			// would read a killed gate as a passing one.
			if (result.killed) {
				return { ok: false, output: output || `Gate command timed out: ${command}` };
			}
			return { ok: result.code === 0, output };
		},

		// Issue 12 ships without saved-workflow resolution — the runtime refuses
		// `workflow()` fatally, naming issue 13.
	};
}
