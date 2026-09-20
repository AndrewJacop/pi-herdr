// Parent-side session-file substrate (v0.6 issue 04 — the foundation of
// pull/push/result everything later stands on).
//
// Children are pi launched with PARENT-OWNED session files: the parent seeds
// `<pi-default sessions dir for the child cwd>/<timestamp>_<uuid>.jsonl` and
// passes `--session <path>` in the launch plan — no custom session dir, no
// `--session-dir`. The file lives exactly where pi puts its own sessions, so
// any spawned session is resumable and perusable from plain pi (`/resume`,
// `pi --session <path>`). The injected child extension (src/child.ts) writes
// the completion sidecar `<session>.exit` beside it.
//
// The session JSONL is the source of truth for the child's result: extraction
// is the EXACT last assistant message object — no screen scraping, no tail
// heuristics, no truncation ambiguity (research §2 ruling).
//
// Sessions are never deleted by pi-herdr: closing a pane loses nothing — the
// pane is not the transcript.

import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

// ---- the pi-default sessions dir -------------------------------------------
// Mirrors pi's SessionManager.getDefaultSessionDirPath encoding exactly
// (dist/core/session-manager.js): take the resolved cwd, strip one leading
// slash/backslash, replace every /, backslash and : with '-', and wrap in
// double dashes — e.g. C:\Users\me becomes --C--Users-me-- under
// <agentDir>/sessions/. Keeping the encoding here (instead of importing pi's
// internal) is deliberate: the two MUST agree, and the offline tests pin ours
// against observed pi output.

/** The encoded directory name pi uses for a cwd (`--C--Users-me--` style). */
export function sessionsDirName(cwd: string): string {
	const resolved = cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-");
	return `--${resolved}--`;
}

/** The pi-default sessions dir for a cwd. */
export function sessionsDirFor(
	cwd: string,
	agentDir: string = getAgentDir(),
): string {
	return join(agentDir, "sessions", sessionsDirName(cwd));
}

/** pi's own session-file naming: `<ISO timestamp, : and . → ->_<uuid>.jsonl`. */
export function newSessionFileName(now: Date = new Date()): string {
	const timestamp = now.toISOString().replace(/[:.]/g, "-");
	return `${timestamp}_${randomUUID()}.jsonl`;
}

export interface SeedSessionDeps {
	/** pi agent dir — default getAgentDir() (injectable for offline tests). */
	agentDir?: string;
	now?: () => Date;
	uuid?: () => string;
	mkdir?: (dir: string) => void;
	/** Seeds the file EMPTY — pi initializes an empty `--session` file with a
	 * valid header itself; a hand-written header would drift with pi's format. */
	writeFile?: (path: string) => void;
}

export interface SeededSession {
	path: string;
	dir: string;
}

/**
 * Seed a parent-owned session file for a child about to run in `cwd`: create
 * pi's default sessions dir for that cwd and an empty `<ts>_<uuid>.jsonl` in
 * it. Called before launch (start time, after the worktree resolves the final
 * cwd); pi keeps the explicit `--session` path verbatim.
 */
export function seedSessionFile(
	cwd: string,
	deps: SeedSessionDeps = {},
): SeededSession {
	const dir = sessionsDirFor(cwd, deps.agentDir);
	(deps.mkdir ?? ((d: string) => mkdirSync(d, { recursive: true })))(dir);
	const uuid = deps.uuid ?? randomUUID;
	const name = `${(deps.now ?? (() => new Date()))()
		.toISOString()
		.replace(/[:.]/g, "-")}_${uuid()}.jsonl`;
	const path = join(dir, name);
	(deps.writeFile ?? ((p: string) => writeFileSync(p, "", { flag: "wx" })))(
		path,
	);
	return { path, dir };
}

// ---- session modes (v0.6 issue 09) --------------------------------------------
// How a child session begins relative to the parent's conversation:
//   standalone   — fresh, no lineage (the previous default; the file stays
//                  EMPTY and pi initializes its own header on boot).
//   lineage-only — the seeded header carries the `parentSession` link, zero
//                  copied turns (pi's /resume builds the lineage tree from it).
//   fork         — the parent conversation copied in, truncated just before
//                  the parent's LAST user message, session-entry noise
//                  filtered — the child boots knowing everything discussed
//                  and receives its task as the natural next user turn.
// Honest costs (wayfinder ticket 05): fork is a context-copy tax (the child
// re-processes the whole copied conversation) and a snapshot (freezes at
// spawn; the pushed result is the only sync-back).
//
// pi facts these builders mirror (dist/core/session-manager.js): the v3
// header is {type:"session",version:3,id,timestamp,cwd,parentSession} where
// parentSession is the parent session FILE PATH (what /resume reads); an
// empty --session file gets a pi-written header, a non-empty one is opened
// as-is with the context built by walking parentId from the leaf — hence the
// fork copy's fresh linear re-chain.

/** Deps for the header/seed builders (injected for offline tests). */
export interface SeedHeaderDeps {
	now?: () => Date;
	uuid?: () => string;
}

/**
 * The child session header (pi's SessionHeader, v3): fresh id, child cwd,
 * and the `parentSession` link — the PARENT SESSION FILE PATH, the same
 * value pi's own fork flow writes and what /resume reads for lineage.
 */
export function buildChildHeader(
	input: { cwd: string; parentSession?: string },
	deps: SeedHeaderDeps = {},
): Record<string, unknown> {
	return {
		type: "session",
		version: 3,
		id: (deps.uuid ?? randomUUID)(),
		timestamp: (deps.now ?? (() => new Date()))().toISOString(),
		cwd: input.cwd,
		...(input.parentSession ? { parentSession: input.parentSession } : {}),
	};
}

/**
 * The fork copy: the parent's conversation truncated just before its LAST
 * user message, session-entry noise filtered, re-chained into a fresh linear
 * tree. Pure.
 *
 *  - Truncation: entries from the last user-message entry onward are dropped
 *    (including the parent's replies to it and any in-flight turn) — the
 *    spawn's task prompt takes that user turn's place. No user message at
 *    all → everything copies. Cutting AT a user boundary never splits a
 *    toolCall/toolResult pair: those live inside a completed assistant turn.
 *  - Noise filter: only `type: "message"` entries copy. Model/thinking
 *    changes, compaction + branch summaries, custom extension entries and
 *    labels are the parent process's session bookkeeping, not conversation.
 *    Pre-compaction messages DO copy: the fork is a snapshot of the
 *    conversation, not of the parent's context window.
 *  - Re-chain: `parentId` is relinked linearly (the first copied entry roots
 *    the tree) because pi's context walk follows parentId from the leaf —
 *    copied links into filtered-out entries would truncate the walk. Original
 *    ids and message objects stay verbatim (traceable to the parent); an
 *    id-less entry gets a deterministic fresh id instead of being dropped.
 */
export function forkCopyEntries(
	entries: Record<string, unknown>[],
): Record<string, unknown>[] {
	let lastUser = -1;
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i];
		if (e.type !== "message") continue;
		const role = (e.message as { role?: unknown } | undefined)?.role;
		if (role === "user") {
			lastUser = i;
			break;
		}
	}
	const end = lastUser === -1 ? entries.length : lastUser;
	const out: Record<string, unknown>[] = [];
	let prevId: string | null = null;
	for (let i = 0; i < end; i++) {
		const e = entries[i];
		if (e.type !== "message") continue;
		const id =
			typeof e.id === "string" && e.id ? e.id : `herdr-fork-${out.length + 1}`;
		out.push({ ...e, id, parentId: prevId });
		prevId = id;
	}
	return out;
}

/**
 * The mode's content lines for a freshly seeded child session file (JSON
 * strings; the writer newline-joins them): the child header, plus the fork
 * copy for fork mode. lineage-only = header only. standalone never calls
 * this — its file stays empty for pi to initialize on boot.
 */
export function buildSessionSeedLines(
	input: {
		cwd: string;
		parentSession: string;
		mode: "lineage-only" | "fork";
		parentEntries: Record<string, unknown>[];
	},
	deps: SeedHeaderDeps = {},
): string[] {
	const header = buildChildHeader(
		{ cwd: input.cwd, parentSession: input.parentSession },
		deps,
	);
	const rest = input.mode === "fork" ? forkCopyEntries(input.parentEntries) : [];
	return [header, ...rest].map((e) => JSON.stringify(e));
}

// ---- session JSONL reading ---------------------------------------------------
// A session file is line-delimited JSON entries. Message entries are
// `{type:"message", id, parentId, timestamp, message:{role, content, ...}}`.
// The child may be writing while we read: a torn final line is skipped, never
// fatal — extraction works on whatever is durably on disk.

/** One parsed session file. */
export interface ParsedSession {
	entries: Record<string, unknown>[];
	/** Lines skipped because they were not complete JSON (torn tail). */
	malformed: number;
}

/** Parse a session file's text into entries (tolerant of a torn final line). */
export function parseSessionEntries(text: string): ParsedSession {
	const entries: Record<string, unknown>[] = [];
	let malformed = 0;
	for (const line of text.split("\n")) {
		const t = line.trim();
		if (!t) continue;
		try {
			const parsed: unknown = JSON.parse(t);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				entries.push(parsed as Record<string, unknown>);
			} else {
				malformed++;
			}
		} catch {
			malformed++;
		}
	}
	return { entries, malformed };
}

export interface SessionMessageContentBlock {
	type?: string;
	text?: string;
	[k: string]: unknown;
}

/** The exact text content of an assistant message (text blocks joined). */
export function assistantText(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content as SessionMessageContentBlock[]) {
		if (block && block.type === "text" && typeof block.text === "string") {
			parts.push(block.text);
		}
	}
	return parts.join("\n");
}

/** The exact last assistant message extracted from a session file. */
export interface ExtractedResult {
	/** The full message object, verbatim from the JSONL (byte-identical data). */
	message: Record<string, unknown>;
	/** Its text content (text blocks joined with newline; "" if none). */
	text: string;
}

/**
 * Extract the last assistant message from parsed entries. Returns null when
 * the file holds none yet (boot window, still working).
 */
export function extractLastAssistant(
	entries: Record<string, unknown>[],
): ExtractedResult | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (!message || typeof message !== "object") continue;
		if ((message as { role?: unknown }).role !== "assistant") continue;
		return {
			message: message as Record<string, unknown>,
			text: assistantText(message),
		};
	}
	return null;
}

// ponytail: extractSessionResult re-reads and re-parses the whole JSONL on
// every poll tick per child — fine at the fleet sizes this tool targets; the
// 07 poll loop should cache by (path, size, mtime) if that ever shows up.
/** Read a session file from disk and extract the last assistant message. */
export function extractSessionResult(
	sessionPath: string,
): ExtractedResult | null {
	if (!existsSync(sessionPath)) return null;
	let text: string;
	try {
		text = readFileSync(sessionPath, "utf8");
	} catch {
		return null;
	}
	return extractLastAssistant(parseSessionEntries(text).entries);
}

/**
 * Mine typed failure info off the last assistant message: pi marks a turn
 * whose retries were exhausted with `stopReason: "error"` + `errorMessage`
 * (provider overload, rate limit, …). Null when the message completed
 * normally or was aborted (the caller decides what those mean).
 */
export function minedAssistantError(message: unknown): {
	stopReason: string;
	errorMessage: string;
} | null {
	if (!message || typeof message !== "object") return null;
	const m = message as { stopReason?: unknown; errorMessage?: unknown };
	if (m.stopReason !== "error") return null;
	const raw = typeof m.errorMessage === "string" ? m.errorMessage.trim() : "";
	return {
		stopReason: "error",
		errorMessage:
			raw ||
			"agent loop ended with stopReason=error (no errorMessage field on the message)",
	};
}

// ---- the completion sidecar ---------------------------------------------------
// `<session>.exit` — written by the injected child extension: `{type:"done"}`
// on declared/settled completion, `{type:"error", errorMessage, stopReason}`
// when the final turn failed. The parent treats it as the child's typed
// terminal declaration (checked BEFORE pane status: an auto-exited pane is
// already gone when its sidecar lands).

export function sidecarPathFor(sessionPath: string): string {
	return `${sessionPath}.exit`;
}

/** A valid completion sidecar payload. `rearm` marks an idle-re-arm exit
 * (issue 06): the run completed AFTER a human takeover — the parent labels
 * the delivery "auto-delivered after user steer". */
export type ExitSidecar =
	| { type: "done"; rearm?: true }
	| { type: "error"; errorMessage: string; stopReason: string; rearm?: true };

/** Parse sidecar text. Anything malformed or of an unknown shape is invalid. */
export function parseExitSidecar(
	raw: string,
): { ok: true; sidecar: ExitSidecar } | { ok: false } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { ok: false };
	}
	if (!parsed || typeof parsed !== "object") return { ok: false };
	const o = parsed as Record<string, unknown>;
	// rearm is optional and tolerated on either type; anything else unknown
	// is ignored (forward compatibility).
	const rearm = o.rearm === true ? { rearm: true as const } : {};
	if (o.type === "done")
		return { ok: true, sidecar: { type: "done", ...rearm } };
	if (o.type === "error") {
		const message =
			typeof o.errorMessage === "string" && o.errorMessage.trim()
				? o.errorMessage
				: "child reported stopReason=error without an errorMessage";
		const stopReason = typeof o.stopReason === "string" ? o.stopReason : "error";
		return {
			ok: true,
			sidecar: { type: "error", errorMessage: message, stopReason, ...rearm },
		};
	}
	return { ok: false };
}

// ---- takeover + steer markers (issue 06) -----------------------------------
// `<session>.takeover` — written ONCE by the injected child extension when a
// HUMAN types into the pane (input that is not the parent's own steering —
// see the steer watermark below). The parent's delivery loop reads it to
// send the quiet `user took over <agent>` note and to hold back
// mid-conversation pushes for that record.
// `<session>.steer` — stamped by the PARENT right before it drives the child
// (spawn's initial submit, message_agent): the exact text about to be typed.
// The child matches incoming input against it so the orchestrator's own
// steering is never mistaken for a human takeover (both ride the same TTY).

/** The takeover marker path for a session file. */
export function takeoverPathFor(sessionPath: string): string {
	return `${sessionPath}.takeover`;
}

/** The steer-watermark path for a session file. */
export function steerPathFor(sessionPath: string): string {
	return `${sessionPath}.steer`;
}

export type ReadTakeoverResult = { taken: false } | { taken: true; at?: number };

/** True when the child has reported a human takeover (marker present). */
export function readTakeoverMarker(sessionPath: string): ReadTakeoverResult {
	const path = takeoverPathFor(sessionPath);
	if (!existsSync(path)) return { taken: false };
	try {
		return { taken: true, at: statSync(path).mtimeMs };
	} catch {
		return { taken: true };
	}
}

/** Parent-side: stamp the exact text about to be typed into the child.
 * Best-effort — worst case the child reads a stale watermark. */
export function writeSteerWatermark(sessionPath: string, text: string): void {
	try {
		writeFileSync(steerPathFor(sessionPath), text);
	} catch {
		/* best-effort */
	}
}

/** Child-side: read (peek, no delete) the current steer watermark. */
export function readSteerWatermark(sessionPath: string): string | null {
	try {
		return readFileSync(steerPathFor(sessionPath), "utf8");
	} catch {
		return null;
	}
}

/** Child-side: consume the watermark after a match. Best-effort. */
export function clearSteerWatermark(sessionPath: string): void {
	try {
		unlinkSync(steerPathFor(sessionPath));
	} catch {
		/* already gone or raced — harmless */
	}
}

/**
 * Whether an input event's text is the parent's steering echo: the typed
 * text is (whitespace-insensitively) part of the stamped watermark. Chunked
 * delivery and short option-list answers match; a human's own words don't.
 */
export function inputMatchesSteer(
	inputText: string | undefined,
	watermark: string | null,
): boolean {
	if (!inputText || !watermark) return false;
	const norm = (s: string): string => s.replace(/\s+/g, " ").trim();
	const i = norm(inputText);
	return i.length > 0 && norm(watermark).includes(i);
}

export type ReadSidecarResult =
	| { state: "missing" }
	| { state: "ok"; sidecar: ExitSidecar }
	| { state: "invalid" };

/**
 * Drop the previous run's sidecars before a resume relaunch (issue 10).
 * The completion sidecar MUST go: a stale done/error would be re-delivered
 * instantly as the resumed run's result (the delivery loop reads it before
 * anything else). The takeover marker would suppress blocked wakes for the
 * new run; a stale activity snapshot would mis-age the first projected
 * state. The `<session>.activity.json` suffix mirrors spawn's construction
 * (`${seeded.path}.activity.json`). Best-effort throughout — an already-
 * gone file is fine.
 */
export function clearSidecars(sessionPath: string): void {
	for (const path of [
		sidecarPathFor(sessionPath),
		takeoverPathFor(sessionPath),
		`${sessionPath}.activity.json`,
	]) {
		try {
			unlinkSync(path);
		} catch {
			/* already gone or raced — harmless */
		}
	}
}

/** Read the completion sidecar for a session file (missing = not finished). */
export function readExitSidecar(sessionPath: string): ReadSidecarResult {
	const path = sidecarPathFor(sessionPath);
	if (!existsSync(path)) return { state: "missing" };
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		// The child may be mid-write; unreadable now reads as missing (the
		// caller's poll loop retries).
		return { state: "missing" };
	}
	const parsed = parseExitSidecar(raw);
	return parsed.ok
		? { state: "ok", sidecar: parsed.sidecar }
		: { state: "invalid" };
}
