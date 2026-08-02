// Tier 5 — Introspection: live snapshot + named sessions.
//
// Two surfaces here:
//  - `api snapshot` — the full live session snapshot (workspaces/tabs/panes/
//    agents + focused ids + version/protocol). The whole-fleet view an
//    orchestrator consults to decide where to route work.
//  - `session list/stop/delete` — herdr's named *persistent sessions* (distinct
//    from per-pane agent state). `session attach` is interactive (TUI) so it is
//    excluded. `session stop`/`delete` are destructive (⚠️): stop tears down a
//    running session's server; delete removes a stopped session's directory.
//
// Each tool is a thin wrapper: build argv -> herdr() -> uniform ToolReturn,
// mirroring orchestration.ts / sync.ts / layout.ts. The argv builders are pure
// (no I/O) so the branching logic is unit-testable offline (`tests/smoke.mjs`).
// These commands target the herdr 0.7.5 surface directly (they don't exist on
// <0.7.5); a legacy build surfaces the server-side error. `--json` is always
// emitted (where supported) so the envelope parser returns structured data.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { herdr } from "../herdr.js";
import {
	type Err,
	type HerdrErrorCode,
	type ToolReturn,
} from "../env.js";

// ---- small helpers (mirror orchestration.ts / sync.ts / layout.ts) ----------

/** Build a non-ok Result with a normalized error code. */
function err(code: HerdrErrorCode, message: string, details?: unknown): Err {
	return { ok: false, error: { code, message, details } };
}

/** Build an error ToolReturn from a non-ok Result. */
function fail(r: Err): ToolReturn {
	return {
		content: [
			{ type: "text", text: `Error (${r.error.code}): ${r.error.message}` },
		],
		details: { error: r.error },
		isError: true,
	};
}

/** Build a success ToolReturn with custom text + structured details. */
function okText(text: string, details: unknown): ToolReturn {
	return { content: [{ type: "text", text }], details };
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

function pickNum(
	o: Record<string, unknown>,
	...keys: string[]
): number | undefined {
	for (const k of keys) {
		const v = o[k];
		if (typeof v === "number") return v;
	}
	return undefined;
}

// ---- normalizers ----------------------------------------------------------

export interface NormalizedSession {
	name?: string;
	running?: boolean;
	default?: boolean;
	sessionDir?: string;
	socketPath?: string;
}
/** Normalize a raw herdr session object (snake_case) into the camelCase contract. */
export function normalizeSession(s: unknown): NormalizedSession {
	if (!s || typeof s !== "object") return {};
	const o = s as Record<string, unknown>;
	return {
		name: pickStr(o, "name"),
		running: typeof o.running === "boolean" ? o.running : undefined,
		default: typeof o.default === "boolean" ? o.default : undefined,
		sessionDir: pickStr(o, "session_dir", "sessionDir"),
		socketPath: pickStr(o, "socket_path", "socketPath"),
	};
}

/** Compact, stable summary of the live session snapshot for the LLM. */
export interface SnapshotSummary {
	version?: string;
	protocol?: number;
	focusedPaneId?: string;
	focusedTabId?: string;
	focusedWorkspaceId?: string;
	workspaceCount?: number;
	tabCount?: number;
	paneCount?: number;
	agentCount?: number;
	workingCount?: number;
}
/**
 * Summarize the live snapshot into counts + focused ids. The snapshot may be
 * nested under `snapshot` (from `api snapshot`) or passed bare; each list is
 * read tolerantly. Returns counts only (the full snapshot stays in `details`).
 */
export function summarizeSnapshot(d: unknown): SnapshotSummary {
	const root =
		d && typeof d === "object" && "snapshot" in (d as Record<string, unknown>)
			? ((d as Record<string, unknown>).snapshot as Record<string, unknown>)
			: (d as Record<string, unknown>);
	if (!root || typeof root !== "object") return {};
	const count = (key: string): number | undefined => {
		const v = root[key];
		return Array.isArray(v) ? v.length : undefined;
	};
	const agents = Array.isArray(root.agents) ? root.agents : [];
	const working = agents.filter(
		(a) =>
			a &&
			typeof a === "object" &&
			(a as Record<string, unknown>).agent_status === "working",
	).length;
	return {
		version: pickStr(root, "version"),
		protocol: pickNum(root, "protocol"),
		focusedPaneId: pickStr(root, "focused_pane_id", "focusedPaneId"),
		focusedTabId: pickStr(root, "focused_tab_id", "focusedTabId"),
		focusedWorkspaceId: pickStr(
			root,
			"focused_workspace_id",
			"focusedWorkspaceId",
		),
		workspaceCount: count("workspaces"),
		tabCount: count("tabs"),
		paneCount: count("panes"),
		agentCount: agents.length,
		workingCount: working,
	};
}

// ---- pure argv builders (unit-testable offline) ----------------------------

/** `api snapshot` (no flags — JSON is the only output form). */
export function apiSnapshotArgs(): string[] {
	return ["api", "snapshot"];
}

/** `session list --json` */
export function sessionListArgs(): string[] {
	return ["session", "list", "--json"];
}

/** `session stop <NAME> --json` (destructive: tears down a running session). */
export function sessionStopArgs(name: string): string[] {
	return ["session", "stop", name, "--json"];
}

/** `session delete <NAME> --json` (destructive: removes a stopped session dir). */
export function sessionDeleteArgs(name: string): string[] {
	return ["session", "delete", name, "--json"];
}

// ---- registration ----------------------------------------------------------

export function registerIntrospection(pi: ExtensionAPI): void {
	// 1. api_snapshot --------------------------------------------------------
	pi.registerTool({
		name: "herdr_api_snapshot",
		label: "Herdr live session snapshot",
		description:
			"Read the full live herdr session snapshot — every workspace, tab, pane, and agent with its state, plus focused ids and server version/protocol. " +
			"The whole-fleet view for routing decisions.",
		promptSnippet: "Read the live herdr session snapshot (whole fleet)",
		promptGuidelines: [
			"Use herdr_api_snapshot for the whole-fleet view (all panes/agents/states) when deciding where to route work; details carry the full snapshot.",
		],
		parameters: Type.Object({}),
		async execute(_id, _p, signal) {
			const r = await herdr<unknown>(apiSnapshotArgs(), {
				timeoutMs: 15_000,
				signal,
			});
			if (!r.ok) return fail(r);
			const summary = summarizeSnapshot(r.data);
			const parts: string[] = [];
			if (summary.version) parts.push(`herdr ${summary.version}`);
			parts.push(
				`${summary.workspaceCount ?? 0} workspace(s), ${summary.tabCount ?? 0} tab(s), ${summary.paneCount ?? 0} pane(s), ${summary.agentCount ?? 0} agent(s)`,
			);
			if (summary.workingCount) parts.push(`${summary.workingCount} working`);
			if (summary.focusedPaneId)
				parts.push(`focused=${summary.focusedPaneId}`);
			return okText(`Live snapshot: ${parts.join(" | ")}.`, {
				summary,
				snapshot: r.data,
			});
		},
	});

	// 2. session_list --------------------------------------------------------
	pi.registerTool({
		name: "herdr_session_list",
		label: "List herdr sessions",
		description:
			"List herdr named persistent sessions. Returns each session's name, running state, default flag, and socket path. " +
			"(Distinct from per-pane agent state — use herdr_list_agents for that.)",
		promptSnippet: "List herdr named persistent sessions",
		promptGuidelines: [
			"Use herdr_session_list to enumerate named sessions (running/stopped); use herdr_list_agents for per-pane agent state.",
		],
		parameters: Type.Object({}),
		async execute(_id, _p, signal) {
			const r = await herdr<{ sessions?: unknown[] }>(sessionListArgs(), {
				timeoutMs: 10_000,
				signal,
			});
			if (!r.ok) return fail(r);
			const sessions = (r.data?.sessions ?? []).map(normalizeSession);
			return okText(
				sessions.length
					? `${sessions.length} session(s):\n` +
						sessions
							.map(
								(s) =>
									`- ${s.name ?? "?"}${s.default ? " (default)" : ""}${s.running ? " [running]" : " [stopped]"}`,
							)
							.join("\n")
					: "No sessions.",
				{ sessions },
			);
		},
	});

	// 3. session_stop (destructive) -----------------------------------------
	// `session stop` tears down a running named session (stops its server). This
	// is distinct from stopping a single agent pane — it ends the session that
	// may hold many panes. Labeled ⚠️ accordingly.
	pi.registerTool({
		name: "herdr_session_stop",
		label: "Stop herdr session",
		description:
			"⚠️ Destructive. Stop a running named herdr session (terminates its server and every pane/tab in it). " +
			"Not the same as closing one pane — this ends the whole session.",
		promptSnippet: "Stop a running herdr session (destructive)",
		promptGuidelines: [
			"Use herdr_session_stop to end a running named session (⚠️ tears down its server + all panes); list names first with herdr_session_list.",
		],
		parameters: Type.Object({
			name: Type.String({ description: "Session name to stop." }),
		}),
		async execute(_id, p, signal) {
			if (!p.name?.length)
				return fail(
					err("VALIDATION_ERROR", "'name' must be a non-empty string."),
				);
			const r = await herdr(sessionStopArgs(p.name), {
				timeoutMs: 30_000,
				signal,
			});
			if (!r.ok) return fail(r);
			return okText(`Stopped session "${p.name}".`, {
				name: p.name,
				stopped: true,
			});
		},
	});

	// 4. session_delete (destructive) ---------------------------------------
	// `session delete` removes a stopped session's on-disk directory. herdr only
	// deletes stopped sessions; deleting a running one surfaces a server error.
	// Labeled ⚠️ because it removes the session directory permanently.
	pi.registerTool({
		name: "herdr_session_delete",
		label: "Delete herdr session",
		description:
			"⚠️ Destructive. Delete a stopped herdr session (removes its on-disk directory). " +
			"The session must be stopped first — use herdr_session_stop.",
		promptSnippet: "Delete a stopped herdr session (destructive)",
		promptGuidelines: [
			"Use herdr_session_delete to remove a stopped session's directory (⚠️ permanent); stop it first with herdr_session_stop if it is running.",
		],
		parameters: Type.Object({
			name: Type.String({ description: "Session name to delete." }),
		}),
		async execute(_id, p, signal) {
			if (!p.name?.length)
				return fail(
					err("VALIDATION_ERROR", "'name' must be a non-empty string."),
				);
			const r = await herdr(sessionDeleteArgs(p.name), {
				timeoutMs: 30_000,
				signal,
			});
			if (!r.ok) return fail(r);
			return okText(`Deleted session "${p.name}".`, {
				name: p.name,
				deleted: true,
			});
		},
	});
}
