// The steer sink (v0.6 issue 14): the ONE envelope every consumer uses to
// steer a message into the orchestrator session — pi.sendMessage with the
// `herdr-delivery` custom type and the wake flags (steer/now vs nextTurn).
//
// Own module so the import graph stays acyclic: the workflow run registry
// (src/workflow/runs.ts) and the fleet widget (src/widget.ts, via runs) both
// need this, and delivery.ts imports the widget for its tick — a shared home
// under neither side keeps delivery → widget → runs → delivery from closing.
// delivery.ts re-exports for compatibility.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { HerdrSettings } from "./settings.js";

/** One steered message (tests capture these through the injected sink). */
export interface SteeredMessage {
	content: string;
	details: Record<string, unknown>;
	/** true → wake the orchestrator now; false → next natural turn. */
	wake: boolean;
}

/**
 * Build the steer sink for a session: pi.sendMessage with delivery's exact
 * envelope (`herdr-delivery`, wake → steer/nextTurn flags). ONE factory so
 * every consumer (the delivery loop, the workflow run's completion report)
 * cannot drift apart.
 */
export function makeDeliverySink(pi: ExtensionAPI): (msg: SteeredMessage) => void {
	return (msg: SteeredMessage): void => {
		try {
			pi.sendMessage(
				{
					customType: "herdr-delivery",
					content: msg.content,
					display: true,
					details: msg.details,
				},
				msg.wake
					? { triggerTurn: true, deliverAs: "steer" }
					: { triggerTurn: false, deliverAs: "nextTurn" },
			);
		} catch {
		/* best-effort — delivery must never break its caller */
		}
	};
}

/** The wake flags for a terminal push under the notifications setting. */
export function terminalWake(
	notes: HerdrSettings["notifications"],
): SteeredMessage["wake"] {
	return notes !== "quiet"; // normal → wake; quiet → next turn; none → never reaches a push
}
