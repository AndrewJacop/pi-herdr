// herdr_run_workflow (v0.6 issue 12): scripted workflow orchestration.
//
// A small JavaScript program — inline `script`, a `scriptPath`, (issue 13 adds
// saved `name` discovery) — runs in the background inside a Node vm sandbox.
// The script's only route to real work is the injected globals (agent(),
// parallel(), pipeline(), phase(), log(), args, budget); each agent() spawns a
// real herdr pane through the ordinary spawn gates (kill-switch → depth →
// cap=queue — no separate pool). The runtime core + worker bootstrap are
// PORTED from tintinweb/pi-subagents (MIT — provenance in the ported file
// headers + the README acknowledgement); this tool surface and the host seam
// (src/workflow/host.ts) are ours.
//
// The tool returns immediately; the run reports once, aggregated, when it
// settles (src/workflow/runs.ts). `workflows_enabled: false` refuses new runs —
// a gate on new runs only, never a stop for one in flight.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ToolReturn } from "../env.js";
import { getSettingsPaths, loadSettings, type HerdrSettings } from "../settings.js";
import {
	startWorkflowRun,
	readScriptFile,
	workflowScratchDir,
} from "../workflow/runs.js";
import { assertBoundarySafe, validateScript } from "../workflow/runtime.js";

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
			"spawns one real pi subagent and resolves to its exact final text (opts: label, phase, agentType, " +
			"model `provider/model-id` exact, effort minimal|low|medium|high|xhigh|max|off, isolation " +
			"`worktree`, gate `shell command that must pass`, resume `label`); `pipeline(items, ...stages)` " +
			"staged fan-out without a barrier; `parallel(thunks)` barrier; `phase(title)`; `log(msg)`; " +
			"`args`; `budget` (`total` is always null). Each `agent()` goes through the ordinary spawn gates " +
			"(kill-switch, depth, parallel cap — over cap it queues). `Date.now()`/`new Date()`/`Math.random()` " +
			"throw (runs must be replayable). Returns immediately with a run id and the script's file path — " +
			"the aggregated result is pushed to you when the run finishes; do NOT poll or sleep waiting for it. " +
			"Every `agent()` costs a real agent: use it when the number of agents depends on something " +
			"discovered at runtime, when work flows through stages, or when findings must be independently " +
			"verified — not to dress a single task up.",
		promptSnippet:
			"Run a sandboxed multi-agent workflow script in the background (fan-out / staged pipelines)",
		promptGuidelines: [
			"Use herdr_run_workflow to fan out over a list discovered at runtime, push items through stages, or verify findings — each agent() spawns a real pi agent.",
			"The run reports once when finished; edit the script file it reports and re-run with scriptPath to iterate. A failed agent() resolves to null — filter(Boolean).",
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
						"A workflow script file, absolute or project-relative. Takes precedence over `script` — this is how an edited workflow is re-run.",
				}),
			),
			args: Type.Optional(
				Type.Any({
					description:
						"Handed to the script as the `args` global, verbatim. Must be JSON-shaped.",
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

			// Source resolution: scriptPath wins over script (the edit-and-re-run
			// loop). Saved-name discovery arrives with issue 13.
			let source = p.script;
			if (p.scriptPath !== undefined) {
				try {
					source = readScriptFile(p.scriptPath, process.cwd());
				} catch (e) {
					return fail(
						`could not read scriptPath "${p.scriptPath}": ${e instanceof Error ? e.message : String(e)}`,
					);
				}
			}
			if (source === undefined || source.trim() === "") {
				return fail("pass `script` (inline source) or `scriptPath` (a file)");
			}

			// Validate BEFORE anything runs: the meta contract, size/control rules,
			// and the JSON boundary on args. Errors are author-facing refusals.
			try {
				assertBoundarySafe(p.args, "args");
				validateScript(source);
			} catch (e) {
				return fail(e instanceof Error ? e.message : String(e));
			}

			const started = startWorkflowRun({
				script: source,
				args: p.args,
				pi,
				ctx,
				...(deps.host !== undefined ? { host: deps.host } : {}),
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
							`Script: ${started.run.scriptPath}\n\n` +
							`You will be notified when it finishes — do NOT poll or sleep waiting for it. ` +
							`To iterate, edit the script file and call herdr_run_workflow again with scriptPath ` +
							`(scratch dir: ${workflowScratchDir()}).`,
					},
				],
				details: {
					runId: started.run.runId,
					name: started.run.meta.name,
					description: started.run.meta.description,
					scriptPath: started.run.scriptPath,
					status: started.run.status,
				},
			};
		},
	});
}
