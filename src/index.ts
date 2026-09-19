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
import { floorError, formatVersion, MIN_HERDR_VERSION } from "./version.js";
import { herdr, probeHerdr, refreshHerdrProbe } from "./herdr.js";

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
	// install/upgrade is noticed immediately. One clean error per problem:
	// missing binary -> warning toast with the install link; below the 0.9.0
	// floor (or unverifiable) -> error toast naming the upgrade pointer. Every
	// herdr() call is gated on the same probe, so no tool half-works below the
	// floor (see herdr.ts).
	pi.on("session_start", (e, ctx) => {
		if (e.reason !== "startup" && e.reason !== "reload") return;
		refreshHerdrProbe().then((probe) => {
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
				// The probe verdict leads: below the floor the fleet call was
				// refused (HERDR_TOO_OLD), so say that instead of "unavailable".
				const vtag =
					probe.state === "ok" ? ` (${formatVersion(probe.version)})` : "";
				if (probe.state === "missing") {
					setStatus("pi-herdr", "herdr: not installed — herdr.dev");
					return;
				}
				if (probe.state === "unknown") {
					setStatus(
						"pi-herdr",
						`herdr: version unknown — needs ≥ ${formatVersion(MIN_HERDR_VERSION)}`,
					);
					return;
				}
				if (probe.state === "ok" && floorError(probe)) {
					setStatus(
						"pi-herdr",
						`herdr: too old (${formatVersion(probe.version)} < ${formatVersion(MIN_HERDR_VERSION)})`,
					);
					return;
				}
				if (!r.ok) {
					setStatus("pi-herdr", `herdr: unavailable${vtag}`);
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
