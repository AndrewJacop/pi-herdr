// The injected child extension (v0.6 issue 04) — loaded into spawned pi
// children via `-e <this file>` (same channel any extension rides; the spawn
// engine appends the flag). It gives a herdr-fleet child its substrate:
//
//   - `agent_done` — the child-side completion declaration: writes the
//     completion sidecar (`<session>.exit`, `{type:"done"}`) and exits. The
//     child's final assistant message is its delivered result (the parent
//     extracts it from the session JSONL — this tool carries no payload).
//   - session naming `herdr/<spawn-name>` at boot, so fleet sessions are
//     identifiable in /resume and never masquerade as the user's own.
//   - typed completion sidecar on auto-exit: `{type:"done"}`, or
//     `{type:"error", errorMessage, stopReason}` mined off the last assistant
//     message (provider-overload retry-exhaustion reaches the parent as a
//     typed failure, not a mystery).
//   - auto-exit on `agent_settled` for autonomous-stance children —
//     `agent_settled`, NOT `agent_end`, is the definitive idle signal (pi may
//     auto-retry/compact/continue after agent_end; mapping matches
//     src/selfreport.ts). Interactive children never auto-close.
//   - the identity/tools strip (`[scout] — 12 tools · 4 denied (Ctrl+H)`)
//     above the child's editor — a human walking into the pane sees what
//     they're in; Ctrl+H expands the full tool list. (The prior art used
//     Ctrl+J; pi binds ctrl+j to tui.input.newLine and ctrl+k to
//     tui.editor.deleteToLineEnd — ctrl+h is unbound.)
//
// Everything keys off the parent-stamped env (PI_HERDR_* namespace; the
// coinstallable prior art uses PI_SUBAGENT_* — no collisions, research §11).
// Without PI_HERDR_SESSION this extension is a no-op, so loading it in a
// non-child pi (or an adopted session) is harmless.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { writeFileSync } from "node:fs";
import {
	clearSteerWatermark,
	inputMatchesSteer,
	readSteerWatermark,
	takeoverPathFor,
} from "./sessionfile.js";

/** Session file path — presence marks this pi as a herdr-spawned child. */
export const ENV_SESSION = "PI_HERDR_SESSION";
/** The spawn handle (pane name). */
export const ENV_NAME = "PI_HERDR_NAME";
/** Registry type the child was spawned from ("" for anonymous inline). */
export const ENV_AGENT = "PI_HERDR_AGENT";
/** "1" = autonomous stance (auto-exit on settle). Unset = interactive. */
export const ENV_AUTO_EXIT = "PI_HERDR_AUTO_EXIT";
/** Comma list of denied tools (for the identity strip count). */
export const ENV_DENIED_TOOLS = "PI_HERDR_DENIED_TOOLS";
/** Activity sidecar path — RESERVED for ticket 07; stamped, not yet written. */
export const ENV_ACTIVITY_FILE = "PI_HERDR_ACTIVITY_FILE";
/** Idle re-arm window in ms (v0.6 issue 06), stamped by the parent from the
 * `idle_rearm_minutes` setting. After a human takeover: settle + this much
 * quiet → the final message auto-delivers (rearm-labeled) and the pane
 * closes. Unset = the 15-minute default. */
export const ENV_IDLE_REARM_MS = "PI_HERDR_IDLE_REARM_MS";

/** A minimal shape of the agent messages this extension inspects. */
export interface AgentMessageLike {
	role?: unknown;
	stopReason?: unknown;
	errorMessage?: unknown;
	[k: string]: unknown;
}

/**
 * Whether a settled run should close an autonomous child. Manual input does
 * not strand the stance: the decision is whether the latest settled run
 * completed normally. `stopReason: "aborted"` stays OPEN (a human interrupted
 * — leave the pane for inspection or another prompt); `stopReason: "error"`
 * still exits (paired with the error sidecar so the parent learns it was a
 * failure, not a clean completion).
 */
export function shouldAutoExitOnSettle(
	messages: AgentMessageLike[] | undefined,
): boolean {
	if (messages) {
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg?.role === "assistant") return msg.stopReason !== "aborted";
		}
	}
	return true;
}

/**
 * If the latest assistant message ended with `stopReason: "error"` (typically
 * auto-retry exhausted on an overload / rate limit / server error), return
 * its mined error info. Null when it completed normally or was aborted.
 */
export function findLatestAssistantError(
	messages: AgentMessageLike[] | undefined,
): { errorMessage: string; stopReason: "error" } | null {
	if (!messages) return null;
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg?.role !== "assistant") continue;
		if (msg.stopReason !== "error") return null;
		const raw =
			typeof msg.errorMessage === "string" ? msg.errorMessage.trim() : "";
		return {
			errorMessage:
				raw || "agent loop ended with stopReason=error (no errorMessage field)",
			stopReason: "error",
		};
	}
	return null;
}

/** The typed completion sidecar payload for a settled run. */
export function buildCompletionSidecar(
	messages: AgentMessageLike[] | undefined,
):
	| { type: "done" }
	| { type: "error"; errorMessage: string; stopReason: "error" } {
	const error = findLatestAssistantError(messages);
	return error ? { type: "error", ...error } : { type: "done" };
}

/** Parse the parent-stamped denied-tools env value. */
export function parseDeniedTools(rawValue: string | undefined): string[] {
	return (rawValue ?? "")
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean);
}

/**
 * The identity/tools strip lines. Collapsed (default):
 * `[scout] — 12 tools · 4 denied (Ctrl+H)`; expanded adds the full tool list
 * and the denied names. Pure so the shape is pinned offline. Ctrl+H: pi binds
 * ctrl+j (newLine) and ctrl+k (deleteToLineEnd); ctrl+h is unbound.
 */
export function identityStripLines(opts: {
	label: string;
	tools: readonly string[];
	denied: readonly string[];
	expanded?: boolean;
}): string[] {
	const tag = opts.label ? `[${opts.label}]` : "[herdr agent]";
	if (!opts.expanded) {
		const denied = opts.denied.length ? ` · ${opts.denied.length} denied` : "";
		return [`${tag} — ${opts.tools.length} tools${denied} (Ctrl+H)`];
	}
	const lines = [
		`${tag} — ${opts.tools.length} tools  (Ctrl+H to collapse)`,
		...(opts.tools.length ? [opts.tools.join(", ")] : []),
	];
	if (opts.denied.length) lines.push(`denied: ${opts.denied.join(", ")}`);
	return lines;
}

/**
 * Grace window (ms) between an error settle and the auto-exit. A settled
 * error is NOT yet retry exhaustion: pi may be scheduling its next retry
 * (backoff gaps grow with each attempt). Exiting on the first error settle
 * would kill the retry machine mid-flight; only a full quiet window — no new
 * run started, no further settle — means the retries are done and the parent
 * must hear the typed failure.
 *
 * Default 30s; PI_HERDR_ERROR_EXIT_GRACE_MS overrides (tests, long-backoff
 * fleets). Read per settle, so a late env change still applies.
 */
export function errorExitGraceMs(): number {
	const raw = Number(process.env.PI_HERDR_ERROR_EXIT_GRACE_MS);
	return Number.isFinite(raw) && raw >= 0 ? raw : 30_000;
}

/**
 * The idle re-arm window (ms) — how long a TAKEN-OVER pane stays open after
 * a settle before it auto-delivers (rearm-labeled) and closes. Timer starts
 * on `agent_settled`, never mid-work; any keystroke resets it (the next
 * settle restarts it). Default 15 min (`idle_rearm_minutes`);
 * PI_HERDR_IDLE_REARM_MS is stamped by the parent and overridable (tests).
 * Read per settle, like errorExitGraceMs.
 */
export function idleRearmMs(): number {
	const raw = Number(process.env[ENV_IDLE_REARM_MS]);
	return Number.isFinite(raw) && raw >= 0 ? raw : 15 * 60_000;
}

/**
 * Register the child extension. A no-op when PI_HERDR_SESSION is unset.
 * Exported (not only the default factory) so offline tests can drive it with
 * a mock pi.
 */
export function registerChildExtension(pi: ExtensionAPI): void {
	const sessionFile = process.env[ENV_SESSION];
	if (!sessionFile) return;
	// Narrowed alias — some nested function declarations below can't rely on
	// the guard's control-flow narrowing.
	const session: string = sessionFile;

	const childName = process.env[ENV_NAME] ?? "";
	const agentType = process.env[ENV_AGENT] ?? "";
	const autoExit = process.env[ENV_AUTO_EXIT] === "1";
	const denied = parseDeniedTools(process.env[ENV_DENIED_TOOLS]);
	const label = agentType || childName;

	let toolNames: string[] = [];
	let expanded = false;

	const sidecarPath = `${sessionFile}.exit`;

	/** Write the completion sidecar. Best-effort: a failed write must not
	 * break the exit path (the session JSONL remains the readable truth).
	 * `rearm` marks an idle-re-arm exit (issue 06) — the parent labels the
	 * delivery "auto-delivered after user steer". */
	function writeSidecar(
		payload:
			| { type: "done" }
			| { type: "error"; errorMessage: string; stopReason: string },
		rearm = false,
	): void {
		try {
			writeFileSync(
				sidecarPath,
				JSON.stringify(rearm ? { ...payload, rearm: true } : payload),
			);
		} catch {
			/* best-effort */
		}
	}

	function renderStrip(ctx: { ui: { setWidget: Function } }): void {
		ctx.ui.setWidget(
			"herdr-identity",
			identityStripLines({ label, tools: toolNames, denied, expanded }),
			{ placement: "aboveEditor" },
		);
	}

	pi.on("session_start", (_event, ctx) => {
		// Fleet sessions are identifiable in /resume and never masquerade as
		// the user's own conversations.
		pi.setSessionName(`herdr/${childName || "agent"}`);
		toolNames = pi
			.getAllTools()
			.map((t) => t.name)
			.sort();
		renderStrip(ctx);
	});

	pi.registerShortcut("ctrl+h", {
		description: "Toggle herdr agent identity/tools strip",
		handler: (ctx) => {
			expanded = !expanded;
			renderStrip(ctx);
		},
	});

	// The child-side completion declaration: mark done, exit. The final
	// assistant message BEFORE this call is the delivered result.
	pi.registerTool({
		name: "agent_done",
		label: "Agent done",
		description:
			"Call this tool when the overall task is complete — it reports completion to the orchestrator " +
			"and closes this session. Your LAST assistant message before calling it is what gets delivered, " +
			"so write the full final summary as a normal assistant message FIRST, then call agent_done. " +
			"Never call it mid-task.",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			writeSidecar({ type: "done" });
			ctx.shutdown();
			return {
				content: [
					{ type: "text", text: "Completion recorded; this session is closing." },
				],
				details: {},
			};
		},
	});

	// agent_end is not terminal (pi may compact/retry/continue after it);
	// hold the messages and wait for agent_settled — the same mapping
	// src/selfreport.ts uses.
	let latestMessages: AgentMessageLike[] | undefined;
	pi.on("agent_end", (event) => {
		// SAFETY: only role/stopReason/errorMessage are ever read, and those are
		// common to every member of pi's AgentMessage union; the union just lacks
		// an index signature for the structural comparison.
		latestMessages = (event as unknown as { messages?: AgentMessageLike[] })
			.messages;
	});

	// A pending error-exit (see agent_settled below). Any new run, any input,
	// or any further settle cancels or reschedules it.
	let errorExitTimer: ReturnType<typeof setTimeout> | null = null;
	function cancelErrorExit(): void {
		if (errorExitTimer) {
			clearTimeout(errorExitTimer);
			errorExitTimer = null;
		}
	}

	// User takeover (issue 06): a HUMAN typed into this pane. Splits two
	// effects — auto-exit is disabled (a pane never slams shut on a human;
	// the idle re-arm window governs the exit instead) while the result
	// contract is never revoked (agent_done stays, the session file stays
	// readable). The marker tells the parent to send its quiet
	// `user took over <agent>` note and hold back mid-conversation pushes.
	let takenOver = false;
	function markTakeover(): void {
		if (takenOver) return;
		takenOver = true;
		try {
			writeFileSync(takeoverPathFor(session), JSON.stringify({ at: Date.now() }));
		} catch {
			/* best-effort — the rearm path still works child-side */
		}
	}

	// The pending idle re-arm exit. Scheduled on agent_settled for a taken-
	// over pane; any input cancels it (the next settle restarts it).
	let rearmTimer: ReturnType<typeof setTimeout> | null = null;
	function cancelRearm(): void {
		if (rearmTimer) {
			clearTimeout(rearmTimer);
			rearmTimer = null;
		}
	}

	/** True for input a HUMAN typed: interactive TTY input that is not the
	 * parent's own steering echo (matched against the <session>.steer
	 * watermark the parent stamps before driving this pane — herdr's agent
	 * prompt and a human's typing are otherwise indistinguishable). */
	function isHumanInput(event: { source?: unknown; text?: unknown }): boolean {
		const watermark = readSteerWatermark(session);
		const text = typeof event.text === "string" ? event.text : undefined;
		if (inputMatchesSteer(text, watermark)) {
			clearSteerWatermark(session);
			return false; // our orchestrator steering itself
		}
		const source = typeof event.source === "string" ? event.source : undefined;
		// "interactive" = typed; "rpc"/"extension" = programmatic, never a
		// human. An absent source (older pi) is treated as human — missing a
		// takeover would let the pane slam shut on someone reading it.
		return source === undefined || source === "interactive";
	}

	pi.on("agent_start", () => {
		// pi started (re)running — a retry survived the grace window decision,
		// and a taken-over pane has new work; any pending re-arm is moot.
		cancelErrorExit();
		cancelRearm();
	});

	pi.on("input", (event) => {
		// Any input stops a pending exit (error-grace or re-arm): the pane is
		// about to be busy again, and the next settle reschedules.
		cancelErrorExit();
		cancelRearm();
		if (isHumanInput(event)) {
			markTakeover();
		}
	});

	pi.on("session_shutdown", () => {
		cancelErrorExit();
		cancelRearm();
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (takenOver) {
			// A human has this pane: never slam it shut, whatever the stance or
			// the settle's mood. The idle re-arm window governs the exit (and
			// the rearm-labeled delivery); any keystroke resets it via input,
			// every fresh settle restarts it. An aborted run stays open with no
			// timer at all — the human interrupted, they're driving.
			cancelErrorExit();
			cancelRearm();
			if (!shouldAutoExitOnSettle(latestMessages)) return;
			rearmTimer = setTimeout(() => {
				rearmTimer = null;
				writeSidecar(buildCompletionSidecar(latestMessages), true);
				ctx.shutdown();
			}, idleRearmMs());
			rearmTimer.unref?.();
			return;
		}
		if (!autoExit) return; // interactive stance — the pane stays open
		if (!shouldAutoExitOnSettle(latestMessages)) {
			// aborted → open for inspection (and no stale error-exit pending)
			cancelErrorExit();
			return;
		}
		const failed = findLatestAssistantError(latestMessages);
		if (!failed) {
			// Clean completion: the definitive settle. Sidecar + exit.
			cancelErrorExit();
			writeSidecar(buildCompletionSidecar(latestMessages));
			ctx.shutdown();
			return;
		}
		// Settled on an error: NOT yet exhaustion. Give pi's retry machine a
		// quiet window; each fresh settle reschedules it, a new run cancels it,
		// and only real quiet (retries done) publishes the typed failure.
		cancelErrorExit();
		errorExitTimer = setTimeout(() => {
			errorExitTimer = null;
			writeSidecar(buildCompletionSidecar(latestMessages));
			ctx.shutdown();
		}, errorExitGraceMs());
		errorExitTimer.unref?.();
	});
}

/** Default factory — the `-e` entry point. */
export default function (pi: ExtensionAPI): void {
	registerChildExtension(pi);
}
