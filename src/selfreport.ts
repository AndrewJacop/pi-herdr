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
 * Legacy channel from older `@juicesharp/rpiv-ask-user-question` (`events.ts`).
 * Channel names are immutable once shipped, so this is kept for back-compat
 * with installs that still emit it. Current `pi-ask-user` (v0.14+) emits
 * `herdr:blocked` instead — see HERDR_BLOCKED_EVENT. Don't invent a `herdr:*`
 * alias yourself; `herdr:blocked` below is the producer's real, current name.
 */
export const ASK_USER_BLOCKED_EVENT = "rpiv:ask-user:blocked" as const;

/**
 * Channel emitted by the CURRENT `pi-ask-user` (v0.14+) when ask_user blocks /
 * resumes (`{ active: boolean, label: string }`), and — same payload shape —
 * by `pi-subagents` for attention/blocked states. pi-herdr is the bridge that
 * turns this in-process signal into a herdr `pane report-agent --state blocked`
 * so every observer (herdr_wait_agent / herdr_delegate) sees it: nothing else in
 * JS consumes it, and herdr's native TUI detection can miss it on some builds.
 */
export const HERDR_BLOCKED_EVENT = "herdr:blocked" as const;

/**
 * Public channel from `pi-cursor-sdk` (`CURSOR_ASK_QUESTION_BLOCKED_EVENT`).
 * Package-namespaced (not bare `cursor:`) so it is not confused with
 * pi-cursor-oauth or standalone cursor-agent. Keep in sync with the producer.
 */
export const CURSOR_ASK_QUESTION_BLOCKED_EVENT =
	"pi-cursor-sdk:ask-question:blocked" as const;

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
 * Map a blocked payload (`{ active: boolean }`) → herdr state.
 * Shared by `herdr:blocked`, `rpiv:ask-user:blocked`, and
 * `pi-cursor-sdk:ask-question:blocked` (all the same `{ active }` shape).
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
 *   herdr:blocked { active: true }              -> blocked
 *   herdr:blocked { active: false }             -> working (resume the turn)
 *   rpiv:ask-user:blocked { active: true }      -> blocked  (legacy channel)
 *   rpiv:ask-user:blocked { active: false }     -> working   (legacy channel)
 *   pi-cursor-sdk:ask-question:blocked { active: true } -> blocked
 *   pi-cursor-sdk:ask-question:blocked { active: false }-> working (resume the turn)
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

	const onAskBlocked = (data: unknown): void => {
		const state = mapAskUserBlockedToState(data);
		if (state) report(state);
	};
	// Current pi-ask-user (v0.14+) ask_user wait + pi-subagents attention. This is
	// the channel producers actually emit today; nothing else bridges it to herdr.
	pi.events.on(HERDR_BLOCKED_EVENT, onAskBlocked);
	// Legacy ask-user wait (TUI + RPC) — older rpiv-ask-user-question builds.
	pi.events.on(ASK_USER_BLOCKED_EVENT, onAskBlocked);
	// cursor_ask_question wait — emitted by pi-cursor-sdk.
	pi.events.on(CURSOR_ASK_QUESTION_BLOCKED_EVENT, onAskBlocked);
}

/** Whether self-report is active in this process (for status/diagnostics). */
export const selfReportActive = ENABLED;
