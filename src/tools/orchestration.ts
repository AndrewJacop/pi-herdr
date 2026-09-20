// Orchestration tools — the model-facing keepers after the v0.6 surface cut
// (wayfinder ticket 09): `herdr_list_agents` (the fleet's single introspection
// tool). The steering tool herdr_send_prompt was absorbed by
// herdr_message_agent (v0.6 issue 05, src/tools/message.ts), which reuses
// sendAgentPrompt; the result-retrieval pair (herdr_wait_agent /
// herdr_read_agent) was retired by herdr_get_agent_result (v0.6 issue 04:
// JSONL result + pane-tail fallback for panes we didn't spawn). Everything
// else this module grew (start/get/stop/rename/focus/explain + the delegate
// composite) is OFF the model surface — deleted registrations, kept machinery:
// `startHerdrAgent` is the one launch path every spawn uses (src/spawn.ts),
// `waitForStatus`/`submitAndWait` power the poll loop, and `agent
// get`/`pane close` remain reachable internally (kill-all, pane lifecycle).
// Code deletion ≠ capability deletion; the LLM just stops seeing it. Each
// tool is a thin wrapper: build argv -> herdr() -> a uniform ToolReturn.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { fleetList, herdr } from "../herdr.js";
import { getAgentKinds } from "../config.js";
import {
	type NormalizedAgent,
	type Err,
	type HerdrErrorCode,
	type Result,
	type ToolReturn,
} from "../env.js";
import { spawnRecords, type SpawnRecord } from "../spawn.js";
import { readExitSidecar, type ReadSidecarResult } from "../sessionfile.js";
import {
	isSubstrateChild,
	projectStatus,
	readActivityFile,
	type ActivityRead,
} from "../status.js";

// The spawn engine consumes this module's machinery (startHerdrAgent,
// waitForStatus, submitAndWait, getAgentStatus, kindError) — the launch path
// survives the surface cut even though `herdr_start_agent` (the tool that
// exposed it directly) does not. Agent-kind validation stays live: `agent`
// is a free string validated against the LIVE `herdr agent` kind list at
// execute time — a stale hardcoded enum can't track the ~20 kinds herdr
// 0.9.x ships. To load a local extension pass agent_args (e.g.
// ["-e","./src/index.ts"]).

// ---- small helpers ---------------------------------------------------------

/** Build an error ToolReturn from a non-ok Result. */
function fail(r: Err): ToolReturn {
	return {
		content: [
			{ type: "text", text: `Error (${r.error.code}): ${r.error.message}` },
		],
		details: { error: r.error },
		isError: true,
	};
}

/** Build a success ToolReturn with custom text + structured details. */
function okText(text: string, details: unknown): ToolReturn {
	return { content: [{ type: "text", text }], details };
}

// ---- agent start: the single launch path ----------------------------------
// herdr >= 0.9.0 `agent start <name> --kind <kind> --pane <id> [-- <agentArgs>]`:
// split a pane from the current one, then attach the agent by kind — on every
// OS (0.9.0 fixed the Windows shim launch + flaky process-tree detection;
// validated e2e on Windows by tests/win-start.mjs). herdr resolves the kind
// to its CLI itself, so there is no local argv/preset machinery. tab/workspace
// targeting has no `agent start` equivalent (pane split has none), so those
// inputs are ignored and the pane lands in the current tab.

// Valid agent kinds live in src/config.ts (getAgentKinds: live `herdr agent`
// list, cached per session, with AGENT_KINDS_FALLBACK for offline herdr).

interface StartInput {
	name: string;
	agent?: string;
	agentArgs?: string[]; // extra flags appended to the agent CLI (e.g. ["-ne","-e","./src/index.ts"])
	cwd?: string;
	split?: "right" | "down";
	tabId?: string;
	workspaceId?: string;
	env?: Record<string, string>;
	focus?: boolean;
	signal?: AbortSignal;
}

/** Build a non-ok Result with a normalized error code. */
function err(code: HerdrErrorCode, message: string, details?: unknown): Err {
	return { ok: false, error: { code, message, details } };
}

/**
 * Validate an agent kind against a known-good list. Returns null when the kind
 * is valid, or a `VALIDATION_ERROR` Result (listing the valid kinds) when not.
 * Pure — no I/O — so the unknown-kind error path can be unit-tested offline.
 */
export function kindError(
	kind: string,
	validKinds: readonly string[],
): Err | null {
	const k = kind.toLowerCase();
	if (validKinds.some((v) => v.toLowerCase() === k)) return null;
	return err(
		"VALIDATION_ERROR",
		`Unknown agent kind "${kind}". Supported kinds: ${validKinds.join(", ")}.`,
		{ kind, validKinds: [...validKinds] },
	);
}

/** Tolerantly pull a pane id out of a `pane split` / `agent start` result. */
function extractPaneId(d: unknown): string | undefined {
	if (!d || typeof d !== "object") return undefined;
	const o = d as Record<string, unknown>;
	const pane =
		o.pane && typeof o.pane === "object"
			? (o.pane as Record<string, unknown>)
			: o;
	for (const k of ["pane_id", "paneId", "id"]) {
		if (typeof pane[k] === "string") return pane[k] as string;
	}
	return undefined;
}

/**
 * The one launch path: validate the kind, split a pane from the current one,
 * then attach the agent with `agent start --kind` (retrying briefly while the
 * freshly-split shell reaches its prompt — `agent_pane_busy`).
 */
export async function startHerdrAgent(
	input: StartInput,
): Promise<Result<{ agent: Record<string, unknown> }>> {
	// Without --cwd, herdr spawns the pane in the DAEMON's cwd (home folder for a
	// restored headless session), not the caller's project. Default to this pi
	// process's cwd so spawned agents land in the session root.
	input.cwd ??= process.cwd();

	// `agent start` takes --kind, not a raw command. Validate the kind against
	// the live `herdr agent` kind list (cached, hardcoded fallback) so an
	// unknown kind fails fast with a clear error instead of a server-side 400.
	const kind = (input.agent ?? "pi").toLowerCase();
	const bad = kindError(kind, await getAgentKinds());
	if (bad) return bad;

	// 1. create the pane (`agent start` needs an existing pane at a shell prompt).
	const splitArgs = [
		"pane",
		"split",
		"--current",
		"--direction",
		input.split ?? "right",
	];
	if (input.cwd) splitArgs.push("--cwd", input.cwd);
	if (input.env)
		for (const [k, v] of Object.entries(input.env))
			splitArgs.push("--env", `${k}=${v}`);
	if (input.focus) splitArgs.push("--focus");
	const splitR = await herdr<unknown>(splitArgs, {
		timeoutMs: 20_000,
		signal: input.signal,
	});
	if (!splitR.ok) return splitR;
	const paneId = extractPaneId(splitR.data);
	if (!paneId) {
		return err("PANE_GONE", "herdr pane split returned no pane id", splitR.data);
	}

	// 2. attach the agent to the pane by kind. `agent start --kind` can fail
	//    fast with `agent_pane_busy` while the freshly-split shell reaches its
	//    prompt, so retry briefly.
	const startArgs = [
		"agent",
		"start",
		input.name,
		"--kind",
		kind,
		"--pane",
		paneId,
	];
	// `agent start ... -- <agent-args>`: pass native agent flags (e.g. pi's
	// `-e ./src/index.ts`) so a spawned agent can load a local extension.
	if (input.agentArgs?.length) startArgs.push("--", ...input.agentArgs);
	const deadline = Date.now() + 6_000;
	let startR: Result<{ agent?: Record<string, unknown> }>;
	do {
		startR = await herdr<{ agent?: Record<string, unknown> }>(startArgs, {
			timeoutMs: 20_000,
			signal: input.signal,
		});
		if (startR.ok) break;
		const code = (startR.error.details as { code?: string } | undefined)?.code;
		if (code !== "agent_pane_busy" || Date.now() >= deadline) break;
		await sleep(250);
	} while (true);
	if (!startR.ok) return startR;
	return {
		ok: true,
		data: {
			agent: (startR.data?.agent ?? { pane_id: paneId }) as Record<
				string,
				unknown
			>,
		},
	};
}

/**
 * Inject text into an agent pane — the ONE send path (spawn prompts, message
 * delivery; herdr_message_agent lands here). submit=true types + presses
 * Enter (`agent prompt`); false types only (`pane send-text`).
 */
export async function sendAgentPrompt(
	paneId: string,
	text: string,
	opts: { submit?: boolean; signal?: AbortSignal } = {},
): Promise<Result<true>> {
	if (opts.submit === false) {
		const r = await herdr(["pane", "send-text", paneId, text], {
			timeoutMs: 15_000,
			signal: opts.signal,
		});
		return r.ok ? { ok: true, data: true } : r;
	}
	const r = await herdr(["agent", "prompt", paneId, text], {
		timeoutMs: 15_000,
		signal: opts.signal,
	});
	return r.ok ? { ok: true, data: true } : r;
}

const sleep = (ms: number): Promise<void> =>
	new Promise((r) => setTimeout(r, ms));

/**
 * Wait for a pane to reach idle OR done, whichever fires first, by racing two
 * transition waits.
 *
 * Why race: a pi pane that loads this extension self-reports its state
 * (src/selfreport.ts), and herdr renders a self-reported idle-after-working as
 * `done`; a pane without self-report is auto-detected and settles on `idle`.
 * Racing both covers each path. We do NOT infer completion from the rendered
 * spinner — that's unreliable because tool-call output replaces the spinner in
 * the viewport, which previously caused premature "idle" reports mid-work.
 *
 * If neither transition fires (e.g. an unequipped agent where herdr missed the
 * transition), both waits time out and we return TIMEOUT — the caller then
 * reads whatever partial output exists.
 */
/**
 * Build a one-shot status-transition wait argv:
 * `agent wait <target> --until <s> [--until <s>...] --timeout <ms>`.
 * `--until` is repeatable, so a single call can race several states (e.g.
 * idle+done) at once.
 */
export function transitionWaitArgs(
	target: string,
	statuses: string[],
	timeoutMs: number,
): string[] {
	const args = ["agent", "wait", target];
	for (const s of statuses) args.push("--until", s);
	args.push("--timeout", String(timeoutMs));
	return args;
}

/**
 * Wait for `paneId` to reach one of `statuses`.
 *
 * Prefers herdr's event-based status wait (prompt, no polling) — `agent wait`
 * with every requested state via the repeatable `--until` — but races it
 * against a polling fallback (`agent get`) because the event command can
 * miss a transition herdr never rendered (e.g. a `done`/`idle` state herdr
 * no longer derives for a pane without self-report). The event promise
 * resolves ONLY on success — on error it stays pending so the poll decides.
 * Whichever path sees a target status first wins; the other is cancelled.
 */
export async function waitForStatus(
	paneId: string,
	statuses: string[],
	deadline: number,
	signal?: AbortSignal,
): Promise<Result<true>> {
	const budget = Math.max(1_000, deadline - Date.now());
	const want = new Set(statuses);
	const ctrl = new AbortController();
	const onParentAbort = () => ctrl.abort();
	if (signal) {
		if (signal.aborted) {
			return { ok: false, error: { code: "TIMEOUT", message: "aborted" } };
		}
		signal.addEventListener("abort", onParentAbort, { once: true });
	}
	type Resolved = { via: "event" | "poll"; r: Result<true> };
	// Event path: one `agent wait` racing every requested state via repeatable
	// `--until` (errors swallowed so the polling fallback gets to run).
	const events = new Promise<Resolved>((resolve) => {
		herdr(transitionWaitArgs(paneId, statuses, budget), {
			timeoutMs: budget + 5_000,
			signal: ctrl.signal,
		}).then((r) => {
			if (r.ok) resolve({ via: "event", r: { ok: true, data: true } });
		});
	});
	// Polling fallback: `agent get` catches a settled state the event wait missed.
	const poll: Promise<Resolved> = (async () => {
		while (Date.now() < deadline) {
			if (ctrl.signal.aborted) {
				return {
					via: "poll",
					r: { ok: false, error: { code: "TIMEOUT", message: "aborted" } },
				};
			}
			const r = await herdr<{
				agent?: { agent_status?: string };
				agent_status?: string;
			}>(["agent", "get", paneId], { timeoutMs: 8_000, signal: ctrl.signal });
			if (r.ok) {
				const st = (r.data?.agent ?? r.data)?.agent_status;
				if (st && want.has(st)) {
					return { via: "poll", r: { ok: true, data: true } };
				}
			}
			await sleep(800);
		}
		return {
			via: "poll",
			r: {
				ok: false,
				error: {
					code: "TIMEOUT",
					message: `timed out polling for ${statuses.join("/")}`,
				},
			},
		};
	})();
	try {
		const first = await Promise.race([events, poll]);
		ctrl.abort(); // cancel the still-running path
		return first.r;
	} finally {
		if (signal) signal.removeEventListener("abort", onParentAbort);
	}
}

/**
 * Wait for a pane to reach idle OR done, whichever fires first.
 * Self-report yields `idle` on herdr ≥0.7.3 (which no longer derives `done`);
 * older builds derived `done`. waitForStatus races the event against a poll.
 */
async function raceIdleDone(
	paneId: string,
	deadline: number,
	signal?: AbortSignal,
): Promise<Result<true>> {
	return waitForStatus(paneId, ["idle", "done"], deadline, signal);
}

/** Read the live agent_status of a pane (idle/working/blocked/done/unknown). */
export async function getAgentStatus(
	paneId: string,
	signal?: AbortSignal,
): Promise<Result<string>> {
	const r = await herdr<{
		agent?: { agent_status?: string };
		agent_status?: string;
	}>(["agent", "get", paneId], { timeoutMs: 10_000, signal });
	if (!r.ok) return r;
	const st = (r.data?.agent ?? r.data)?.agent_status;
	if (!st) {
		return err("VALIDATION_ERROR", `agent get returned no status for ${paneId}`);
	}
	return { ok: true, data: st };
}

/**
 *
 * Phase 1 (start): `agent wait --until working` — herdr's idle->working
 * transition is reliable (both auto-detect and self-report).
 *
 * Phase 2 (finish): race `idle`/`done` (see raceIdleDone). Completion relies on
 * self-report (the reliable signal) or herdr's auto-detect; we never force the
 * state ourselves, so we can't report a still-working pane as idle.
 *
 * Returns ok on completion, or an error whose `message` is "NOT_STARTED" when
 * the turn never entered working (caller may re-send the prompt).
 */
async function driveOneTurn(
	paneId: string,
	opts: { deadline: number; workingWindowMs?: number; signal?: AbortSignal },
): Promise<Result<true>> {
	const { signal } = opts;
	const workingBudget = Math.min(
		opts.workingWindowMs ?? 30_000,
		Math.max(2_000, opts.deadline - Date.now()),
	);
	const working = await waitForStatus(
		paneId,
		["working"],
		Date.now() + workingBudget,
		signal,
	);
	if (!working.ok) {
		return { ok: false, error: { ...working.error, message: "NOT_STARTED" } };
	}
	return raceIdleDone(paneId, opts.deadline, signal);
}

/**
 * Build the atomic submit+wait argv:
 * `agent prompt <target> <text> --wait --timeout <ms>`.
 */
export function promptWaitArgs(
	target: string,
	text: string,
	timeoutMs: number,
): string[] {
	return [
		"agent",
		"prompt",
		target,
		text,
		"--wait",
		"--timeout",
		String(timeoutMs),
	];
}

/**
 * Submit a prompt and wait for the turn to settle — one call:
 * `agent prompt <target> <text> --wait --timeout <ms>`.
 *
 * `agent prompt --wait` submits (bracketed-paste) AND blocks until the first
 * settled `idle`/`done`/`blocked` observed after submission. When the prompt
 * is submitted from a non-working state but no working transition is observed
 * within herdr's 5s grace window, herdr returns `agent_prompt_stalled` (the
 * prompt was likely lost — e.g. sent before the TUI input was ready). Rather
 * than hang, fall back to the wait/poll dance so the caller's retry loop can
 * re-send. Any other error propagates unchanged.
 *
 * Returns `NOT_STARTED` (in `error.message`) when the turn never entered
 * working, so the caller (the spawn engine) can re-send.
 */
export async function submitAndWait(
	paneId: string,
	text: string,
	opts: { deadline: number; signal?: AbortSignal },
): Promise<Result<true>> {
	const { signal } = opts;
	const budget = Math.max(2_000, opts.deadline - Date.now());
	const waitR = await herdr(promptWaitArgs(paneId, text, budget), {
		timeoutMs: budget + 8_000,
		signal,
	});
	if (waitR.ok) return { ok: true, data: true };
	const code = (waitR.error.details as { code?: string } | undefined)?.code;
	// agent_prompt_stalled: prompt submitted but no working transition within
	// herdr's grace window — don't hang. Drive the already-submitted turn via
	// wait/poll; NOT_STARTED lets the caller's retry re-send.
	if (code !== "agent_prompt_stalled") return waitR;
	return driveOneTurn(paneId, { deadline: opts.deadline, signal });
}

// ---- list_agents: the projected fleet view (v0.6 issue 07) -----------------

export interface FleetRow {
	paneId?: string;
	name?: string;
	kind?: string;
	/** The projected state label (`active · bash 7m`, `queued`, `stalled`…)
	 * for our records; the coarse agentStatus for adopted panes. */
	state: string;
	/** True when the state is one of the ten projected states. */
	projected: boolean;
	/** The raw coarse status (always available). */
	agentStatus?: string;
	stance?: string;
}

export interface ListAgentsDeps {
	list?: (signal?: AbortSignal) => Promise<Result<NormalizedAgent[]>>;
	registry?: () => ReadonlyMap<string, SpawnRecord>;
	readSidecar?: (sessionPath: string) => ReadSidecarResult;
	readActivity?: (activityPath?: string) => ActivityRead;
	now?: () => number;
	signal?: AbortSignal;
}

const defaultFleetList = fleetList;

/**
 * The fleet's projected view: our registry records report one of the ten
 * states (queued from the parallel-cap queue, active · <tool> <age> from
 * activity snapshots, stalled/gone from absence, finalizing from the
 * completion sidecar); panes this session didn't spawn keep their coarse
 * status. Delivered (consumed) records leave the table.
 */
export async function listAgentsView(
	deps: ListAgentsDeps = {},
): Promise<Result<{ rows: FleetRow[] }>> {
	const fleet = await (deps.list ?? defaultFleetList)(deps.signal);
	if (!fleet.ok) return fleet;
	const registry = deps.registry ?? spawnRecords;
	const now = deps.now ?? (() => Date.now());
	const rows: FleetRow[] = [];
	const seenPanes = new Set<string>();
	// The registry is keyed by handle (name); fleet rows address panes.
	const byPane = new Map<string, SpawnRecord>();
	for (const record of registry().values())
		if (record.paneId) byPane.set(record.paneId, record);

	for (const a of fleet.data) {
		if (!a.paneId) continue;
		seenPanes.add(a.paneId);
		const record = byPane.get(a.paneId);
		if (!record) {
			// adopted pane — coarse status, not ours to project
			rows.push({
				paneId: a.paneId,
				name: a.name,
				kind: a.agent,
				state: a.agentStatus ?? "unknown",
				projected: false,
				agentStatus: a.agentStatus,
			});
			continue;
		}
		rows.push({
			paneId: a.paneId,
			name: record.name,
			kind: record.kind,
			state: projectedLabel(record, deps, a.agentStatus, false, now()),
			projected: true,
			agentStatus: a.agentStatus,
			stance: record.stance,
		});
	}

	// registry records the fleet doesn't show: queued (no pane yet), or a
	// pane that just vanished (undelivered → stalled/finalizing, honest
	// snapshot). Delivered (consumed) records leave the table.
	for (const record of registry().values()) {
		if (record.delivery) continue;
		if (record.paneId && seenPanes.has(record.paneId)) continue;
		rows.push({
			paneId: record.paneId,
			name: record.name,
			kind: record.kind,
			state: projectedLabel(record, deps, undefined, true, now()),
			projected: true,
			stance: record.stance,
		});
	}
	return { ok: true, data: { rows } };
}

/** Project one record (shared by the live-fleet loop and the vanished/
 * queued loop so the sidecar read can't drift between them). */
function projectedLabel(
	record: SpawnRecord,
	deps: ListAgentsDeps,
	live: string | undefined,
	absent: boolean,
	now: number,
): string {
	const sidecarOk = Boolean(
		isSubstrateChild(record) &&
			record.sessionPath &&
			(deps.readSidecar ?? readExitSidecar)(record.sessionPath).state === "ok",
	);
	const proj = projectStatus(record, {
		live,
		absent,
		unhealthy: false,
		sidecar: sidecarOk,
		activity: (deps.readActivity ?? readActivityFile)(record.activityPath),
		now,
	});
	return proj.detail ? `${proj.status} · ${proj.detail}` : proj.status;
}

// ---- registration ----------------------------------------------------------

export function registerOrchestration(pi: ExtensionAPI): void {
// 2. read_agent — RETIRED (v0.6 issue 04): result reads moved to
//    herdr_get_agent_result (session JSONL for spawned pi children,
//    pane-tail fallback only for panes we didn't spawn). Raw pane reads
//    remain on the pane-sync surface (herdr_read_pane).

// 3. wait_agent — RETIRED (v0.6 issue 04): waiting for a result moved to
//    herdr_get_agent_result's `wait` (sidecar-aware, queue-aware).

// 4. send_prompt — ABSORBED (v0.6 issue 05): steering/answers moved to
//    herdr_message_agent (src/tools/message.ts), the open channel with the
//    envelope + resolution chain. sendAgentPrompt survives as the shared
//    delivery path; resolvePaneId died with it (message resolves via its own
//    `agent get`, which also carries the state the physics branch needs).

/** One `- pane [state] name (kind, stance)` line. */
function formatFleetRow(a: FleetRow): string {
	const stance = a.stance ? `, ${a.stance}` : "";
	return `- ${a.paneId ?? "?"} [${a.state}] ${a.name ?? ""} (${a.kind ?? "?"}${stance})`;
}

// 5. list_agents ----------------------------------------------------------
	pi.registerTool({
		name: "herdr_list_agents",
		label: "List herdr agents",
		description:
			"List all agents currently running in herdr — the fleet's single introspection tool. " +
			"Agents this session spawned report their projected state (queued/starting/active · tool/waiting/blocked/stalled/running/finalizing/gone, e.g. `active · bash 7m`); " +
			"panes from elsewhere keep their coarse status. Per-agent detail comes from steering the agent, not from extra tools.",
		promptSnippet: "List all herdr agent panes and their statuses",
		promptGuidelines: [
			"Use herdr_list_agents to see what agent panes exist and their states.",
		],
		parameters: Type.Object({}),
		async execute(_id, _p, signal) {
			const r = await listAgentsView({ signal });
			if (!r.ok) return fail(r);
			const { rows } = r.data;
			const text = rows.length
				? `${rows.length} agent(s):\n${rows.map(formatFleetRow).join("\n")}`
				: "No agents running.";
			return okText(text, { rows });
		},
	});
}
