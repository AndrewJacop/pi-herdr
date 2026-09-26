// herdr_run_workflow (v0.6 issue 12 + 13): scripted workflow orchestration.
//
// A small JavaScript program — inline `script`, a `scriptPath`, or a saved
// `name` (resolved .pi/workflows/ → .agents/workflows/ → the global agent dir,
// first hit wins) — runs in the background inside a Node vm sandbox.
// The script's only route to real work is the injected globals (agent(),
// parallel(), pipeline(), phase(), log(), args, budget); each agent() spawns a
// real herdr pane through the ordinary spawn gates (kill-switch → depth →
// cap=queue — no separate pool). The runtime core + worker bootstrap are
// PORTED from tintinweb/pi-subagents (MIT — provenance in the ported file
// headers + the README acknowledgement); this tool surface and the host seam
// (src/workflow/host.ts) are ours.
//
// `resumeFromRunId` (issue 13) replays the unchanged prefix of a prior run's
// journal — an edited suffix pays only the delta; a journaled failure ends the
// prefix, so resuming retries from the failure point. Same session only.
//
// The tool returns immediately; the run reports once, aggregated, when it
// settles (src/workflow/runs.ts). `workflows_enabled: false` refuses new runs —
// a gate on new runs only, never a stop for one in flight.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ToolReturn } from "../env.js";
import { getSettingsPaths, loadSettings, type HerdrSettings } from "../settings.js";
import {
	resolveResumeTarget,
	startWorkflowRun,
	workflowScratchDir,
} from "../workflow/runs.js";
import { resolveWorkflowScript } from "../workflow/saved.js";
import { readJournal } from "../workflow/journal.js";
import { RUN_ID_PATTERN, assertBoundarySafe, validateScript } from "../workflow/runtime.js";

function fail(message: string, code = "VALIDATION_ERROR"): ToolReturn {
	return {
		content: [{ type: "text", text: `Error (${code}): ${message}` }],
		details: { error: { code, message } },
		isError: true,
	};
}

/** Injectable seams (offline red-green; defaults hit disk + the live host). */
export interface WorkflowToolDeps {
	/** Effective settings — default: live read of both settings files. */
	load?: () => HerdrSettings;
	/** Override the run's host — default: createWorkflowHost. */
	host?: import("../workflow/runtime.js").WorkflowHost;
	/** Passed to startWorkflowRun (manual e2e F15 auto-save location; tests
	 * point it at a temp dir so the repo's .pi/workflows stays untouched). */
	cwd?: string;
}

export function registerWorkflowTool(pi: ExtensionAPI, deps: WorkflowToolDeps = {}): void {
	// The settings gate (ticket checkbox: `workflows_enabled: false` REMOVES the
	// tool from the surface) — evaluated at registration. The execute-time guard
	// below covers the hot-reload case: toggled off mid-session, the already-
	// registered tool refuses new runs until /reload re-evaluates registration.
	const enabledAtLoad = (
		deps.load ?? (() => loadSettings(getSettingsPaths(process.cwd())).effective)
	)().workflows_enabled;
	if (!enabledAtLoad) return;

	pi.registerTool({
		name: "herdr_run_workflow",
		label: "Run herdr workflow",
		description:
			"Run a scripted multi-agent workflow in the background. `script` is a small JavaScript program " +
			"(opens with `export const meta = { name, description }`; top-level `await` and `return` allowed) " +
			"executed in a sandbox — no filesystem, no network, no eval. Its globals: `agent(prompt, opts)` " +
			"spawns one real pi subagent and resolves to its exact final text (opts: label — becomes the child's spawn name, " +
			"which must start with a lowercase letter and contain only lowercase letters, digits, '-' or '_' (herdr's agent-name " +
			"rule: no dots, spaces, or uppercase; sanitize file-derived labels, e.g. `f.toLowerCase().replace(/[^a-z0-9-]+/g,'-')`), " +
			"phase, agentType, " +
			"model `provider/model-id` exact, effort minimal|low|medium|high|xhigh|max|off, isolation " +
			"`worktree`, gate `shell command that must pass`, resume `label`); `pipeline(items, ...stages)` " +
			"staged fan-out without a barrier; `parallel(thunks)` barrier; `phase(title)`; `log(msg)`; " +
			"`args`; `budget` (`total` is always null); `workflow(nameOrRef, args)` runs a saved workflow or script file " +
			"as a nested sub-step (one level). Each `agent()` goes through the ordinary spawn gates " +
			"(kill-switch, depth, parallel cap — over cap it queues). `Date.now()`/`new Date()`/`Math.random()` " +
			"throw (runs must be replayable). Source: `scriptPath`, `script`, or `name` — a saved `<name>.js` from " +
			".pi/workflows/, .agents/workflows/ or the agent dir (that precedence). An inline `script` is AUTO-SAVED to " +
			"<cwd>/.pi/workflows/<meta.name>.js (a differing existing file gets the first free -2/-3 suffix; an unwritable " +
			"cwd falls back to temp scratch), so the receipt's Script: path resolves again via `name:` — that is how " +
			"`name:` re-runs work for inline runs. `resumeFromRunId` replays an earlier " +
			"run's unchanged prefix from its journal — an edited suffix pays only the delta; a failed agent ends the prefix, " +
			"so resuming retries from the failure. Same session only. Returns immediately with a run id and the script's file path — " +
			"the aggregated result is pushed to you when the run finishes; do NOT poll or sleep waiting for it. " +
			"Every `agent()` costs a real agent: use it when the number of agents depends on something " +
			"discovered at runtime, when work flows through stages, or when findings must be independently " +
			"verified — not to dress a single task up.",
		promptSnippet:
			"Run a sandboxed multi-agent workflow script in the background (fan-out / staged pipelines)",
		promptGuidelines: [
			"Use herdr_run_workflow to fan out over a list discovered at runtime, push items through stages, or verify findings — each agent() spawns a real pi agent.",
			"The run reports once when finished; edit the script file it reports and re-run with scriptPath (plus resumeFromRunId to replay the unchanged prefix) to iterate. A failed agent() resolves to null — filter(Boolean).",
			"agent() opts.label becomes the child's spawn name: herdr requires it to start with a lowercase letter and contain only lowercase letters, digits, '-' or '_' — no dots, spaces, or uppercase. Sanitize file-derived labels, e.g. `f.toLowerCase().replace(/[^a-z0-9-]+/g,'-')`.",
			"An inline script auto-saves to .pi/workflows/<meta.name>.js, so the same script can be re-run later with name: (differing content gets a -2/-3 suffix) instead of re-sending the source.",
		],
		parameters: Type.Object({
			script: Type.Optional(
				Type.String({
					description:
						"Inline workflow source. Must begin with `export const meta = { name, description }` (a pure literal).",
				}),
			),
			scriptPath: Type.Optional(
				Type.String({
					description:
						"A workflow script file, absolute or project-relative. Takes precedence over `script` and `name` — this is how an edited workflow is re-run.",
				}),
			),
			name: Type.Optional(
				Type.String({
					description:
						"Name of a saved workflow — `<name>.js` in .pi/workflows/, .agents/workflows/ or the agent dir's workflows/. Lowest precedence: `scriptPath` and `script` both win over it.",
				}),
			),
			args: Type.Optional(
				Type.Any({
					description:
						"Handed to the script as the `args` global, verbatim. Must be JSON-shaped (an object); a JSON string is auto-parsed to the value it encodes — a non-JSON string is refused.",
				}),
			),
			resumeFromRunId: Type.Optional(
				Type.String({
					pattern: RUN_ID_PATTERN,
					description:
						"Run id of an earlier workflow in this session. Its unchanged leading agent() calls return their recorded results instantly; the first changed or failed call, and everything after it, runs live. Same script and args means nothing re-runs.",
				}),
			),
		}),
		async execute(
			_id,
			p,
			_signal,
			_onUpdate,
			ctx: ExtensionContext | undefined,
		) {
			// The settings gate (issue 02's table): off → the tool refuses new runs.
			const settings = (deps.load ?? (() => loadSettings(getSettingsPaths(process.cwd())).effective))();
			if (!settings.workflows_enabled) {
				return fail(
					"workflows_enabled is false — toggle it in the /subagents menu to run workflows.",
					"SPAWN_REFUSED",
				);
			}

			// Resume target first: an unknown id is an error, not a cold start, and
			// a run that is still going cannot be resumed (its journal is mid-write).
			const resumeFrom = resolveResumeTarget(p.resumeFromRunId);
			if (resumeFrom !== undefined && !resumeFrom.ok) {
				return fail(resumeFrom.message);
			}

			// Source resolution, one definition for the tool and nested workflow()
			// alike: scriptPath wins over script, which wins over a saved name. A
			// resume with no source of its own re-runs what that run ran — the
			// common case is an edited script, but "run that again, cheaply" should
			// not require repeating a path the run already knows.
			let ref: { script?: string; scriptPath?: string; name?: string } = p;
			let resumedFrom: { runId: string; journalPath: string } | undefined;
			if (resumeFrom !== undefined && resumeFrom.ok) {
				resumedFrom = { runId: resumeFrom.runId, journalPath: resumeFrom.journalPath };
				if (p.script === undefined && p.scriptPath === undefined && p.name === undefined) {
					ref = { scriptPath: resumeFrom.scriptPath };
				}
			}
			const resolved = resolveWorkflowScript(ref, process.cwd());
			if (!resolved.ok) return fail(resolved.message);
			const source = resolved.script;

			// Manual e2e F12: the double-encoded-args slip — the model passes the
			// object as a JSON string. A string that parses becomes the value it
			// encodes; one that doesn't is refused with the fix in the message.
			let args: unknown = p.args;
			if (typeof args === "string") {
				const trimmed = args.trim();
				try {
					args = JSON.parse(trimmed);
				} catch {
					return fail(
						"args looks like a double-encoded JSON string that doesn't parse — pass the object itself, e.g. args: {files: [...]}",
					);
				}
			}

			// Validate BEFORE anything runs: the meta contract, size/control rules,
			// and the JSON boundary on args. Errors are author-facing refusals.
			try {
				assertBoundarySafe(args, "args");
				validateScript(source);
			} catch (e) {
				return fail(e instanceof Error ? e.message : String(e));
			}

			const started = startWorkflowRun({
				script: source,
				args,
				pi,
				ctx,
				...(deps.host !== undefined ? { host: deps.host } : {}),
				...(deps.cwd !== undefined ? { cwd: deps.cwd } : {}),
				...(resumedFrom !== undefined ? { resumeFrom: resumedFrom } : {}),
				// A named or file-backed run reports ITS file as the scriptPath: the
				// edit-and-re-run loop then works on the source, and a bare
				// resumeFromRunId picks up edits to it.
				...(resolved.scriptPath !== undefined ? { sourcePath: resolved.scriptPath } : {}),
			});
			void started.done.catch(() => {
				/* the run reports its own failure; nothing awaits this promise */
			});
			return {
				content: [
					{
						type: "text",
						text:
							`Workflow "${started.run.meta.name}" started in the background.\n` +
							`Run ID: ${started.run.runId}\n` +
							`Script: ${started.run.scriptPath}\n` +
							(resumedFrom !== undefined
								? `Resuming ${resumedFrom.runId}: ${
										readJournal(resumedFrom.journalPath).length
									} recorded call(s) available to replay.\n`
								: "") +
							`\nYou will be notified when it finishes — do NOT poll or sleep waiting for it. ` +
							`To iterate, edit the script file and call herdr_run_workflow again with scriptPath ` +
							`(and resumeFromRunId ${started.run.runId} to replay the unchanged prefix) ` +
							`(scratch dir: ${workflowScratchDir()}).`,
					},
				],
				details: {
					runId: started.run.runId,
					name: started.run.meta.name,
					description: started.run.meta.description,
					scriptPath: started.run.scriptPath,
					...(started.run.resumedFrom !== undefined ? { resumedFrom: started.run.resumedFrom } : {}),
					status: started.run.status,
				},
			};
		},
	});
}
