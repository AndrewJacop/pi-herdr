// pi-herdr extension entry point.
// Registers the herdr tool surface and surfaces fleet status in the pi footer.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerOrchestration } from "./tools/orchestration.js";
import { registerAgents } from "./tools/agents.js";
import { registerPaneSync } from "./tools/sync.js";
import { registerLayout } from "./tools/layout.js";
import { registerWorktrees } from "./tools/worktrees.js";
import { registerIntrospection } from "./tools/introspection.js";
import { registerSelfReport } from "./selfreport.js";
import { registerHerdrCommand } from "./menu.js";
import { herdr } from "./herdr.js";
import { formatVersion, probeHerdr, refreshHerdrProbe } from "./version.js";

export default function (pi: ExtensionAPI): void {
	// Push this pi's own state to herdr so agent_status is reliable for everyone
	// (fixes herdr's working -> idle detection misses). No-op outside herdr.
	registerSelfReport(pi);

	registerOrchestration(pi);
	registerAgents(pi);
	registerPaneSync(pi);
	registerLayout(pi);
	registerWorktrees(pi);
	registerIntrospection(pi);

	// The /herdr command: settings menu + confirmed Kill-all-agents action.
	registerHerdrCommand(pi);

	// Re-probe herdr on a fresh run (startup) or after /reload so an
	// install/upgrade is noticed immediately; toast when it's missing/unparseable.
	pi.on("session_start", (e, ctx) => {
		if (e.reason !== "startup" && e.reason !== "reload") return;
		refreshHerdrProbe().then((probe) => {
			if (probe.state === "ok" || !ctx.hasUI) return;
			const msg =
				probe.state === "missing"
					? "herdr not found on PATH — install it from https://herdr.dev (e.g. `brew install herdr`) to use the herdr tools."
					: "herdr is installed but its version could not be determined; some herdr tools may not work correctly.";
			ctx.ui.notify(msg, "warning");
		});
	});

	// NFR-6: optional footer status showing the herdr fleet while orchestrating.
	const updateStatus = (
		setStatus: (key: string, text: string) => void,
	): void => {
		Promise.all([
			herdr<{ agents?: { agent_status?: string }[] }>(["agent", "list"], {
				timeoutMs: 5_000,
			}),
			probeHerdr(),
		])
			.then(([r, probe]) => {
				const vtag =
					probe.state === "ok" ? ` (${formatVersion(probe.version)})` : "";
				if (!r.ok) {
					setStatus(
						"pi-herdr",
						(probe.state === "missing"
							? "herdr: not installed — herdr.dev"
							: "herdr: unavailable") + vtag,
					);
					return;
				}
				const agents = r.data?.agents ?? [];
				const working = agents.filter((a) => a.agent_status === "working").length;
				const noun = agents.length === 1 ? "agent" : "agents";
				setStatus(
					"pi-herdr",
					`herdr: ${agents.length} ${noun}${working ? ` (${working} working)` : ""}${vtag}`,
				);
			})
			.catch(() => {
				/* status is best-effort */
			});
	};

	pi.on("agent_start", (_e, ctx) => {
		updateStatus((k, t) => ctx.ui.setStatus(k, t));
	});
	pi.on("turn_end", (_e, ctx) => {
		updateStatus((k, t) => ctx.ui.setStatus(k, t));
	});
}
