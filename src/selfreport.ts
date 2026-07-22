// Self-report this pi's state to herdr so herdr's `agent_status` is accurate.
//
// WHY: herdr detects pi's state by watching the TUI. It reliably catches
// idle -> working but sometimes MISSES working -> idle, leaving the pane stuck
// on "working" after the agent finishes. By having pi push its own state via
// `pane report-agent`, herdr's status becomes reliable for every observer
// (including herdr_wait_agent / herdr_delegate on the orchestrator side).
//
// Active only when running inside a herdr pane (HERDR_PANE_ID + HERDR_ENV set),
// so it's a safe no-op elsewhere. Disable with PI_HERDR_NO_SELF_REPORT=1.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { herdr } from "./herdr.js";

const PANE_ID = process.env.HERDR_PANE_ID;
const AGENT_LABEL = process.env.PI_HERDR_AGENT_LABEL ?? "pi";
const ENABLED =
	!!PANE_ID &&
	process.env.HERDR_ENV === "1" &&
	!process.env.PI_HERDR_NO_SELF_REPORT;

const SOURCE = "pi-herdr";

/**
 * Public channel from `@juicesharp/rpiv-ask-user-question` (`events.ts`).
 * Channel names are immutable once shipped — keep this string in sync, do not
 * invent a `herdr:*` alias here.
 */
export const ASK_USER_BLOCKED_EVENT = "rpiv:ask-user:blocked" as const;

// Start from the clock so the seq is monotonically increasing across pi
// restarts within the same pane (a fresh low seq could be ignored as stale).
let seq = Date.now();

function report(state: "idle" | "working" | "blocked" | "unknown"): void {
	if (!ENABLED || !PANE_ID) return;
	const args = [
		"pane",
		"report-agent",
		PANE_ID,
		"--source",
		SOURCE,
		"--agent",
		AGENT_LABEL,
		"--state",
		state,
		"--seq",
		String(++seq),
	];
	// Best-effort, fire-and-forget. Must never block or break the agent lifecycle.
	herdr(args, { timeoutMs: 5_000 }).catch(() => {});
}

/**
 * Map `rpiv:ask-user:blocked` payload → herdr state.
 * `active: false` returns `working` (turn still in progress), not `idle`.
 * Unknown payloads return `null` (ignore).
 */
export function mapAskUserBlockedToState(
	data: unknown,
): "blocked" | "working" | null {
	if (typeof data !== "object" || data === null) return null;
	if (typeof (data as { active?: unknown }).active !== "boolean") return null;
	return (data as { active: boolean }).active ? "blocked" : "working";
}

/**
 * Register lifecycle hooks that push pi's state to herdr.
 * No-op when not running inside a herdr pane.
 *
 * Mapping:
 *   session_start   -> idle   (booted, waiting at the prompt)
 *   agent_start     -> working (a run began)
 *   agent_settled   -> idle   (pi will not auto-retry/compact/follow-up — truly done)
 *   session_shutdown-> idle
 *   rpiv:ask-user:blocked { active: true }  -> blocked
 *   rpiv:ask-user:blocked { active: false } -> working (resume the turn)
 *
 * `agent_end` is deliberately NOT mapped: pi may auto-retry, auto-compact, or
 * continue with a queued follow-up after it, so reporting idle there would
 * flicker. `agent_settled` is the definitive idle signal.
 */
export function registerSelfReport(pi: ExtensionAPI): void {
	if (!ENABLED) return;
	pi.on("session_start", () => report("idle"));
	pi.on("agent_start", () => report("working"));
	pi.on("agent_settled", () => report("idle"));
	pi.on("session_shutdown", () => report("idle"));

	// Questionnaire wait (TUI + RPC) — emitted by rpiv-ask-user-question.
	pi.events.on(ASK_USER_BLOCKED_EVENT, (data: unknown) => {
		const state = mapAskUserBlockedToState(data);
		if (state) report(state);
	});
}

/** Whether self-report is active in this process (for status/diagnostics). */
export const selfReportActive = ENABLED;
