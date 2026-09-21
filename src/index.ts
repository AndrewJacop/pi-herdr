// pi-herdr extension entry point.
// Registers the herdr tool surface and surfaces fleet status in the pi footer.
//
// The v0.6 surface (issue 02 cut + issue 04/05): ONE surface — herdr_spawn_agent,
// herdr_save_agent (the `.md` registry), herdr_get_agent_result
// (the pull/inspection tool: exact JSONL result for spawned pi children,
// pane-tail fallback for panes we didn't spawn; retired the wait/read pair of
// the legacy result trio), herdr_message_agent (the open channel; absorbed
// the last of the trio, herdr_send_prompt), herdr_interrupt_agent /
// herdr_resume_agent (the lifecycle pair, issue 10), herdr_list_agents, and the
// pane-sync quartet. Layout, tab/workspace, worktree, and introspection tools
// are OFF the model surface; their machinery survives internally (spawn's
// isolated worktrees, the poll loop, kill-all's pane closes). The /subagents
// command is the only command.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerOrchestration } from "./tools/orchestration.js";
import { registerResultTool } from "./tools/result.js";
import { registerMessageTool } from "./tools/message.js";
import { registerLifecycle } from "./tools/lifecycle.js";
import { registerAgents } from "./tools/agents.js";
import { registerPaneSync } from "./tools/sync.js";
import { registerWorkflowTool } from "./tools/workflow.js";
import { stopAllWorkflowRuns } from "./workflow/runs.js";
import { registerDelivery, stopDeliveryLoop } from "./delivery.js";
import { registerFleetWidget } from "./widget.js";
import { registerSelfReport } from "./selfreport.js";
import { registerSubagentsCommand } from "./menu.js";
import { refreshHerdrProbe } from "./herdr.js";
import {
	floorError,
	formatVersion,
	MIN_HERDR_VERSION,
	type HerdrProbe,
} from "./version.js";

export default function (pi: ExtensionAPI): void {
	// Push this pi's own state to herdr so agent_status is reliable for everyone
	// (fixes herdr's working -> idle detection misses). No-op outside herdr.
	registerSelfReport(pi);

	registerOrchestration(pi);
	registerResultTool(pi);
	registerMessageTool(pi);
	// Lifecycle actions (v0.6 issue 10): herdr_interrupt_agent (turn cancel)
	// + herdr_resume_agent (the gone-agent recovery move on the retained
	// session file).
	registerLifecycle(pi);
	registerAgents(pi);
	registerPaneSync(pi);
	// Scripted workflows (v0.6 issue 12): herdr_run_workflow — the vm runtime +
	// host seam. `workflows_enabled: false` refuses new runs (a gate, not a stop).
	registerWorkflowTool(pi);

	// Push delivery (v0.6 issue 06): the shared poll loop watches the spawn
	// registry and steers terminal events into THIS session — full final
	// messages, takeover notes, blocked wakes — with wake governed by the
	// `notifications` setting (blocked always wakes).
	registerDelivery(pi);
	pi.on("session_shutdown", () => {
		stopDeliveryLoop();
		// Workflow runs do not outlive their session (issue 12): terminate the
		// workers; the run signal's abort closes the in-flight children host-side.
		stopAllWorkflowRuns();
	});
	// The fleet widget (v0.6 issue 11) rides the SAME tick as a third
	// consumer — the ambient table above the editor, read-only.
	registerFleetWidget(pi);

	// The /subagents command: settings menu + confirmed Kill-all-agents action.
	registerSubagentsCommand(pi);

	// Re-probe herdr on a fresh run (startup) or after /reload so an
	// install/upgrade is noticed immediately. One clean error per problem:
	// missing binary -> warning toast with the install link; below the 0.9.0
	// floor (or unverifiable) -> error toast naming the upgrade pointer. Every
	// herdr() call is gated on the same probe, so no tool half-works below the
	// floor (see herdr.ts).
	pi.on("session_start", (e, ctx) => {
		if (e.reason !== "startup" && e.reason !== "reload") return;
		refreshHerdrProbe().then((probe) => {
			// Diagnostics-only footer (v0.6 issue 11): the fleet widget carries
			// the agent counts; the footer keeps the version tag + failure
			// verdicts. Set from the probe verdict — no fleet polling here.
			ctx.ui.setStatus("pi-herdr", footerStatus(probe));
			if (probe.state === "ok" || !ctx.hasUI) return;
			if (probe.state === "missing") {
				ctx.ui.notify(
					"herdr not found on PATH — install it from https://herdr.dev (e.g. `brew install herdr`) to use the herdr tools.",
					"warning",
				);
				return;
			}
			const floor = floorError(probe);
			if (floor) ctx.ui.notify(floor.error.message, "error");
		});
	});
}

/** Diagnostics-only footer (v0.6 issue 11): the fleet widget carries the
 * agent counts; the footer keeps the version tag + failure verdicts. */
function footerStatus(probe: HerdrProbe): string {
	if (probe.state === "missing") return "herdr: not installed — herdr.dev";
	if (probe.state === "unknown")
		return `herdr: version unknown — needs ≥ ${formatVersion(MIN_HERDR_VERSION)}`;
	if (floorError(probe))
		return `herdr: too old (${formatVersion(probe.version)} < ${formatVersion(MIN_HERDR_VERSION)})`;
	return `herdr ${formatVersion(probe.version)}`;
}
