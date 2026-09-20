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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

// ---- the pi-default sessions dir -------------------------------------------
// Mirrors pi's SessionManager.getDefaultSessionDirPath encoding exactly
// (dist/core/session-manager.js): `--<resolvedCwd with /,\,: → ->>--` under
// `<agentDir>/sessions/`. Keeping the encoding here (instead of importing
// pi's internal) is deliberate: the two MUST agree, and the offline tests pin
// ours against observed pi output.

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

/** A valid completion sidecar payload. */
export type ExitSidecar =
	| { type: "done" }
	| { type: "error"; errorMessage: string; stopReason: string };

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
	if (o.type === "done") return { ok: true, sidecar: { type: "done" } };
	if (o.type === "error") {
		const message =
			typeof o.errorMessage === "string" && o.errorMessage.trim()
				? o.errorMessage
				: "child reported stopReason=error without an errorMessage";
		const stopReason = typeof o.stopReason === "string" ? o.stopReason : "error";
		return {
			ok: true,
			sidecar: { type: "error", errorMessage: message, stopReason },
		};
	}
	return { ok: false };
}

export type ReadSidecarResult =
	| { state: "missing" }
	| { state: "ok"; sidecar: ExitSidecar }
	| { state: "invalid" };

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
