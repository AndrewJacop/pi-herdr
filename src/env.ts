// Shared types and helpers for the pi-herdr extension.

/** Flexible agent/pane address — herdr resolves paneId, agent name, or label. */
export type Target = string;

/** herdr agent state machine values. */
export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

/** Fixed, normalized error code set surfaced to the LLM. */
export type HerdrErrorCode =
	| "TIMEOUT"
	| "NOT_FOUND"
	| "VALIDATION_ERROR"
	| "AGENT_START_FAILED"
	| "HERDR_UNAVAILABLE"
	| "PANE_GONE";

/** Built-in agent presets (extensible via HERDR_PRESET_* env). */
export type AgentPreset = "pi" | "claude" | "codex" | "omp" | "custom";

export interface Ok<T> {
	ok: true;
	data: T;
}
export interface Err {
	ok: false;
	error: { code: HerdrErrorCode; message: string; details?: unknown };
}
/** Uniform result envelope used across every tool/herdr call. */
export type Result<T> = Ok<T> | Err;

/** A pi tool content block. */
export interface ToolContent {
	type: "text";
	text: string;
}
/** A pi tool execute() return value. */
export interface ToolReturn {
	content: ToolContent[];
	details: unknown;
	isError?: boolean;
}

/**
 * Turn a `Result<T>` into a pi tool `execute()` return value.
 * - On ok: `details` is the raw data; `content` is `formatOk(data)` (or a JSON dump).
 * - On error: `content` carries a readable `Error (CODE): message` string,
 *   `details` carries `{ error }`, and `isError` is set so pi flags the call.
 *
 * Using this everywhere keeps every tool's error/output contract identical.
 */
export function unwrap<T>(
	r: Result<T>,
	formatOk?: (data: T) => string,
): ToolReturn {
	if (r.ok) {
		let text: string;
		if (formatOk) text = formatOk(r.data);
		else if (typeof r.data === "string") text = r.data;
		else text = JSON.stringify(r.data, null, 2);
		return {
			content: [{ type: "text", text }],
			details: r.data,
		};
	}
	return {
		content: [
			{ type: "text", text: `Error (${r.error.code}): ${r.error.message}` },
		],
		details: { error: r.error },
		isError: true,
	};
}

/**
 * Normalize a raw herdr agent object (snake_case) into the camelCase contract
 * documented in the PRD tool table. Tolerates either casing.
 */
export interface NormalizedAgent {
	paneId?: string;
	name?: string;
	agent?: string;
	agentStatus?: AgentStatus | string;
	cwd?: string;
	focused?: boolean;
	tabId?: string;
	workspaceId?: string;
}
export function normalizeAgent(a: unknown): NormalizedAgent {
	if (!a || typeof a !== "object") return {};
	const o = a as Record<string, unknown>;
	return {
		paneId: pickStr(o, "pane_id", "paneId"),
		name: pickStr(o, "name"),
		agent: pickStr(o, "agent"),
		agentStatus: pickStr(o, "agent_status", "agentStatus"),
		cwd: pickStr(o, "cwd"),
		focused: typeof o.focused === "boolean" ? o.focused : undefined,
		tabId: pickStr(o, "tab_id", "tabId"),
		workspaceId: pickStr(o, "workspace_id", "workspaceId"),
	};
}

function pickStr(
	o: Record<string, unknown>,
	...keys: string[]
): string | undefined {
	for (const k of keys) {
		const v = o[k];
		if (typeof v === "string") return v;
	}
	return undefined;
}

/** Extract textual output from a herdr `agent read` / `pane read` result.
 *  The payload may be a bare string, `{text}` at top level, or nested under a
 *  wrapper key (`{read:{text}}` / `{pane_read:{text}}`), so we search shallowly. */
function findTextField(o: unknown, depth = 0): string | undefined {
	if (!o || typeof o !== "object" || depth > 2) return undefined;
	const obj = o as Record<string, unknown>;
	for (const k of ["text", "output", "content", "data"]) {
		if (typeof obj[k] === "string") return obj[k] as string;
	}
	for (const v of Object.values(obj)) {
		if (v && typeof v === "object") {
			const found = findTextField(v, depth + 1);
			if (found !== undefined) return found;
		}
	}
	return undefined;
}

export function extractText(d: unknown): string {
	if (d == null) return "";
	if (typeof d === "string") return d;
	if (Array.isArray(d)) return d.join("\n");
	if (typeof d === "object") {
		const found = findTextField(d);
		if (found !== undefined) return found;
		const o = d as Record<string, unknown>;
		if (Array.isArray(o.lines)) return (o.lines as unknown[]).join("\n");
	}
	return JSON.stringify(d, null, 2);
}
