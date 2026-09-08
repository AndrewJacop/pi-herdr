// Tier 2 — Layout tools (panes / tabs / workspaces CRUD).
//
// herdr 0.7.5 organizes the UI as workspaces → tabs → panes. This tier exposes
// the CRUD surface for each level so an orchestrator can build, rearrange, and
// tear down layouts: list/get/resize/zoom/move/swap panes; create/list/get/
// focus/rename/close tabs and workspaces.
//
// `herdr_split_pane` and `herdr_close_pane` already live in `tools/sync.ts`
// (Tier 3) — they are the pane create/destroy primitives and are reused, not
// re-defined here. This module adds the remaining pane ops + the tab and
// workspace surfaces.
//
// Each tool is a thin wrapper: build argv -> herdr() -> uniform ToolReturn,
// mirroring orchestration.ts / sync.ts. The argv builders are pure (no I/O) so
// the branching logic is unit-testable offline (`tests/smoke.mjs`).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { herdr } from "../herdr.js";
import {
	normalizeAgent,
	type Err,
	type HerdrErrorCode,
	type ToolReturn,
} from "../env.js";

// ---- small helpers (mirror orchestration.ts / sync.ts) ---------------------

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

export interface NormalizedTab {
	tabId?: string;
	label?: string;
	number?: number;
	paneCount?: number;
	workspaceId?: string;
	focused?: boolean;
	agentStatus?: string;
}
/** Normalize a raw herdr tab object (snake_case) into camelCase. */
export function normalizeTab(t: unknown): NormalizedTab {
	if (!t || typeof t !== "object") return {};
	const o = t as Record<string, unknown>;
	return {
		tabId: pickStr(o, "tab_id", "tabId"),
		label: pickStr(o, "label"),
		workspaceId: pickStr(o, "workspace_id", "workspaceId"),
		agentStatus: pickStr(o, "agent_status", "agentStatus"),
		number: pickNum(o, "number"),
		paneCount: pickNum(o, "pane_count", "paneCount"),
		focused: typeof o.focused === "boolean" ? o.focused : undefined,
	};
}

export interface NormalizedWorkspace {
	workspaceId?: string;
	label?: string;
	number?: number;
	paneCount?: number;
	tabCount?: number;
	activeTabId?: string;
	focused?: boolean;
	agentStatus?: string;
}
/** Normalize a raw herdr workspace object (snake_case) into camelCase. */
export function normalizeWorkspace(w: unknown): NormalizedWorkspace {
	if (!w || typeof w !== "object") return {};
	const o = w as Record<string, unknown>;
	return {
		workspaceId: pickStr(o, "workspace_id", "workspaceId"),
		label: pickStr(o, "label"),
		activeTabId: pickStr(o, "active_tab_id", "activeTabId"),
		agentStatus: pickStr(o, "agent_status", "agentStatus"),
		number: pickNum(o, "number"),
		paneCount: pickNum(o, "pane_count", "paneCount"),
		tabCount: pickNum(o, "tab_count", "tabCount"),
		focused: typeof o.focused === "boolean" ? o.focused : undefined,
	};
}

/**
 * Tolerantly pull an id out of a herdr result, looking both at the top level and
 * under a wrapper key (e.g. `{tab:{tab_id}}` from `tab get`, or `{tab_id}` from
 * `tab create`). `idKeys` lists candidate field names in priority order.
 */
function extractId(
	d: unknown,
	idKeys: string[],
	wrapperKey?: string,
): string | undefined {
	if (!d || typeof d !== "object") return undefined;
	const o = d as Record<string, unknown>;
	const src =
		wrapperKey && o[wrapperKey] && typeof o[wrapperKey] === "object"
			? (o[wrapperKey] as Record<string, unknown>)
			: o;
	for (const k of idKeys)
		if (typeof src[k] === "string") return src[k] as string;
	return undefined;
}

/** `--pane <id>` when a pane is named, else `--current` (act on the focused pane). */
function targetArgs(paneId?: string): string[] {
	return paneId ? ["--pane", paneId] : ["--current"];
}

/** Expand a focus boolean into the matching herdr flag (omitted when undefined). */
function focusFlag(focus: boolean | undefined): string[] {
	if (focus === true) return ["--focus"];
	if (focus === false) return ["--no-focus"];
	return [];
}

/** Expand an env map into repeated `--env KEY=VALUE` args. */
function envArgs(env?: Record<string, string>): string[] {
	const out: string[] = [];
	if (env)
		for (const [k, v] of Object.entries(env)) out.push("--env", `${k}=${v}`);
	return out;
}

// ---- pure argv builders (unit-testable offline) ----------------------------

/** `pane list [--workspace <ID>]` */
export function listPanesArgs(opts: { workspaceId?: string } = {}): string[] {
	return opts.workspaceId
		? ["pane", "list", "--workspace", opts.workspaceId]
		: ["pane", "list"];
}

/** `pane resize --direction <d> [--amount <f>] (--pane <id> | --current)` */
export function resizePaneArgs(opts: {
	direction: string;
	amount?: number;
	paneId?: string;
}): string[] {
	const args = ["pane", "resize", "--direction", opts.direction];
	if (opts.amount != null) args.push("--amount", String(opts.amount));
	args.push(...targetArgs(opts.paneId));
	return args;
}

/** `pane zoom [--toggle|--on|--off] (--pane <id> | --current)` */
export function zoomPaneArgs(
	opts: { mode?: "toggle" | "on" | "off"; paneId?: string } = {},
): string[] {
	const mode = opts.mode ?? "toggle";
	const args = ["pane", "zoom"];
	if (mode === "on") args.push("--on");
	else if (mode === "off") args.push("--off");
	else args.push("--toggle");
	args.push(...targetArgs(opts.paneId));
	return args;
}

/** `pane move <pane_id> [--tab/--split/--target-pane/--ratio/--new-tab/--workspace/--new-workspace]` */
export function movePaneArgs(opts: {
	paneId: string;
	tabId?: string;
	split?: string;
	targetPane?: string;
	ratio?: number;
	newTab?: boolean;
	workspaceId?: string;
	newWorkspace?: boolean;
}): string[] {
	const args = ["pane", "move", opts.paneId];
	if (opts.tabId) args.push("--tab", opts.tabId);
	if (opts.split) args.push("--split", opts.split);
	if (opts.targetPane) args.push("--target-pane", opts.targetPane);
	if (opts.ratio != null) args.push("--ratio", String(opts.ratio));
	if (opts.newTab) args.push("--new-tab");
	if (opts.workspaceId) args.push("--workspace", opts.workspaceId);
	if (opts.newWorkspace) args.push("--new-workspace");
	return args;
}

/** `pane swap [--direction] (--pane <id> | --current) [--source-pane] [--target-pane]` */
export function swapPanesArgs(
	opts: {
		direction?: string;
		paneId?: string;
		sourcePane?: string;
		targetPane?: string;
	} = {},
): string[] {
	const args = ["pane", "swap"];
	if (opts.direction) args.push("--direction", opts.direction);
	args.push(...targetArgs(opts.paneId));
	if (opts.sourcePane) args.push("--source-pane", opts.sourcePane);
	if (opts.targetPane) args.push("--target-pane", opts.targetPane);
	return args;
}

/** `tab list [--workspace <ID>]` */
export function listTabsArgs(opts: { workspaceId?: string } = {}): string[] {
	return opts.workspaceId
		? ["tab", "list", "--workspace", opts.workspaceId]
		: ["tab", "list"];
}

/** `tab create [--workspace] [--cwd] [--label] [--env...] [--focus|--no-focus]` */
export function createTabArgs(opts: {
	workspaceId?: string;
	cwd?: string;
	label?: string;
	env?: Record<string, string>;
	focus?: boolean;
}): string[] {
	const args = ["tab", "create"];
	if (opts.workspaceId) args.push("--workspace", opts.workspaceId);
	if (opts.cwd) args.push("--cwd", opts.cwd);
	if (opts.label) args.push("--label", opts.label);
	args.push(...envArgs(opts.env), ...focusFlag(opts.focus));
	return args;
}

/** `workspace create [--cwd] [--label] [--env...] [--focus|--no-focus]` */
export function createWorkspaceArgs(opts: {
	cwd?: string;
	label?: string;
	env?: Record<string, string>;
	focus?: boolean;
}): string[] {
	const args = ["workspace", "create"];
	if (opts.cwd) args.push("--cwd", opts.cwd);
	if (opts.label) args.push("--label", opts.label);
	args.push(...envArgs(opts.env), ...focusFlag(opts.focus));
	return args;
}

// ---- registration ----------------------------------------------------------

export function registerLayout(pi: ExtensionAPI): void {
	// ===================== PANES ============================================

	// 1. list_panes ----------------------------------------------------------
	pi.registerTool({
		name: "herdr_list_panes",
		label: "List herdr panes",
		description:
			"List panes (raw terminals and agent panes) in a workspace. Returns each pane's id, agent kind, status, cwd, and focus.",
		promptSnippet: "List herdr panes and their status",
		promptGuidelines: [
			"Use herdr_list_panes to enumerate panes in a workspace (optionally filtered by workspaceId); pair with herdr_get_pane for one pane's details.",
		],
		parameters: Type.Object({
			workspaceId: Type.Optional(
				Type.String({ description: "Limit to a workspace id (e.g. 'w1')." }),
			),
		}),
		async execute(_id, p, signal) {
			const r = await herdr<{ panes?: unknown[] }>(
				listPanesArgs({ workspaceId: p.workspaceId }),
				{ timeoutMs: 10_000, signal },
			);
			if (!r.ok) return fail(r);
			const panes = (r.data?.panes ?? []).map(normalizeAgent);
			return okText(
				panes.length
					? `${panes.length} pane(s):\n` +
							panes
								.map(
									(a) =>
										`- ${a.paneId ?? "?"} [${a.agentStatus ?? "?"}] ${a.agent ?? "?"} ${a.focused ? "(focused) " : ""}${a.cwd ?? ""}`,
								)
								.join("\n")
					: "No panes.",
				{ panes },
			);
		},
	});

	// 2. get_pane ------------------------------------------------------------
	pi.registerTool({
		name: "herdr_get_pane",
		label: "Get herdr pane",
		description: "Show details of a single pane by id.",
		promptSnippet: "Get one pane's details",
		promptGuidelines: [
			"Use herdr_get_pane to inspect a single pane (agent kind, status, cwd, tab/workspace) by id.",
		],
		parameters: Type.Object({
			paneId: Type.String({ description: "Pane id (e.g. 'w1:p3')." }),
		}),
		async execute(_id, p, signal) {
			const r = await herdr<{ pane?: Record<string, unknown> }>(
				["pane", "get", p.paneId],
				{ timeoutMs: 10_000, signal },
			);
			if (!r.ok) return fail(r);
			const a = normalizeAgent(r.data?.pane ?? r.data);
			return okText(
				`Pane ${a.paneId ?? p.paneId}: ${a.agent ?? "no agent"} [${a.agentStatus ?? "?"}]${a.focused ? " (focused)" : ""} cwd=${a.cwd ?? "?"} tab=${a.tabId ?? "?"} workspace=${a.workspaceId ?? "?"}.`,
				a,
			);
		},
	});

	// 3. resize_pane ---------------------------------------------------------
	pi.registerTool({
		name: "herdr_resize_pane",
		label: "Resize herdr pane",
		description:
			"Resize a pane split by moving an edge in a direction. Targets the focused pane by default, or a specific paneId.",
		promptSnippet: "Resize a pane split (direction + optional amount)",
		promptGuidelines: [
			"Use herdr_resize_pane to grow/shrink a pane; give a direction (left/right/up/down) and optional amount, defaulting to the focused pane.",
		],
		parameters: Type.Object({
			direction: StringEnum(["left", "right", "up", "down"] as const, {
				description: "Edge to move when resizing.",
			}),
			amount: Type.Optional(
				Type.Number({
					description: "How far to move the edge (float; herdr default if omitted).",
				}),
			),
			paneId: Type.Optional(
				Type.String({
					description: "Pane to resize (default: the focused pane).",
				}),
			),
		}),
		async execute(_id, p, signal) {
			const r = await herdr(
				resizePaneArgs({
					direction: p.direction,
					amount: p.amount,
					paneId: p.paneId,
				}),
				{ timeoutMs: 10_000, signal },
			);
			if (!r.ok) return fail(r);
			return okText(
				`Resized pane ${p.paneId ? p.paneId : "(focused)"} ${p.direction}${p.amount != null ? ` by ${p.amount}` : ""}.`,
				{ paneId: p.paneId, direction: p.direction, amount: p.amount },
			);
		},
	});

	// 4. zoom_pane -----------------------------------------------------------
	pi.registerTool({
		name: "herdr_zoom_pane",
		label: "Zoom herdr pane",
		description:
			"Toggle, enable, or disable pane zoom (full-pane focus within a split). Targets the focused pane by default, or a specific paneId.",
		promptSnippet: "Toggle/set pane zoom",
		promptGuidelines: [
			"Use herdr_zoom_pane to toggle (default) or explicitly set zoom on/off for a pane.",
		],
		parameters: Type.Object({
			mode: Type.Optional(
				StringEnum(["toggle", "on", "off"] as const, {
					description: "Zoom action (default 'toggle').",
				}),
			),
			paneId: Type.Optional(
				Type.String({
					description: "Pane to zoom (default: the focused pane).",
				}),
			),
		}),
		async execute(_id, p, signal) {
			const r = await herdr(zoomPaneArgs({ mode: p.mode, paneId: p.paneId }), {
				timeoutMs: 10_000,
				signal,
			});
			if (!r.ok) return fail(r);
			const mode = p.mode ?? "toggle";
			return okText(
				`Zoom ${mode} applied to pane ${p.paneId ? p.paneId : "(focused)"}.`,
				{ paneId: p.paneId, mode },
			);
		},
	});

	// 5. move_pane -----------------------------------------------------------
	pi.registerTool({
		name: "herdr_move_pane",
		label: "Move herdr pane",
		description:
			"Move a pane to another tab/workspace, or next to a target pane. Supports splitting direction and ratio at the destination, or opening a new tab/workspace.",
		promptSnippet:
			"Move a pane to another tab/workspace or next to a target pane",
		promptGuidelines: [
			"Use herdr_move_pane to relocate a pane (e.g. into a tab, next to a target pane, or a brand-new tab/workspace).",
		],
		parameters: Type.Object({
			paneId: Type.String({ description: "Pane to move." }),
			tabId: Type.Optional(Type.String({ description: "Destination tab id." })),
			split: Type.Optional(
				StringEnum(["right", "down"] as const, {
					description: "Split direction at the destination.",
				}),
			),
			targetPane: Type.Optional(
				Type.String({ description: "Place next to this pane id." }),
			),
			ratio: Type.Optional(
				Type.Number({ description: "Split ratio at the destination (float)." }),
			),
			newTab: Type.Optional(
				Type.Boolean({ description: "Move into a newly created tab." }),
			),
			workspaceId: Type.Optional(
				Type.String({ description: "Destination workspace id." }),
			),
			newWorkspace: Type.Optional(
				Type.Boolean({ description: "Move into a newly created workspace." }),
			),
		}),
		async execute(_id, p, signal) {
			const r = await herdr(
				movePaneArgs({
					paneId: p.paneId,
					tabId: p.tabId,
					split: p.split,
					targetPane: p.targetPane,
					ratio: p.ratio,
					newTab: p.newTab,
					workspaceId: p.workspaceId,
					newWorkspace: p.newWorkspace,
				}),
				{ timeoutMs: 10_000, signal },
			);
			if (!r.ok) return fail(r);
			return okText(`Moved pane ${p.paneId}.`, {
				paneId: p.paneId,
				tabId: p.tabId,
				split: p.split,
				targetPane: p.targetPane,
				ratio: p.ratio,
				newTab: p.newTab,
				workspaceId: p.workspaceId,
				newWorkspace: p.newWorkspace,
			});
		},
	});

	// 6. swap_panes ----------------------------------------------------------
	pi.registerTool({
		name: "herdr_swap_panes",
		label: "Swap herdr panes",
		description:
			"Swap two panes: by neighbor direction, or explicit source/target pane ids. Defaults to the focused pane.",
		promptSnippet: "Swap two panes (direction or explicit source/target)",
		promptGuidelines: [
			"Use herdr_swap_panes to exchange two panes — by direction (left/right/up/down) or explicit sourcePane/targetPane.",
		],
		parameters: Type.Object({
			direction: Type.Optional(
				StringEnum(["left", "right", "up", "down"] as const, {
					description: "Swap with the neighbor in this direction.",
				}),
			),
			paneId: Type.Optional(
				Type.String({
					description: "One pane to swap (default: the focused pane).",
				}),
			),
			sourcePane: Type.Optional(
				Type.String({ description: "Explicit source pane id." }),
			),
			targetPane: Type.Optional(
				Type.String({ description: "Explicit target pane id." }),
			),
		}),
		async execute(_id, p, signal) {
			const r = await herdr(
				swapPanesArgs({
					direction: p.direction,
					paneId: p.paneId,
					sourcePane: p.sourcePane,
					targetPane: p.targetPane,
				}),
				{ timeoutMs: 10_000, signal },
			);
			if (!r.ok) return fail(r);
			return okText(
				`Swapped panes (${p.sourcePane ?? p.paneId ?? "focused"} <-> ${p.targetPane ?? p.direction ?? "?"}).`,
				{
					direction: p.direction,
					paneId: p.paneId,
					sourcePane: p.sourcePane,
					targetPane: p.targetPane,
				},
			);
		},
	});

	// ===================== TABS =============================================

	// 7. list_tabs -----------------------------------------------------------
	pi.registerTool({
		name: "herdr_list_tabs",
		label: "List herdr tabs",
		description:
			"List tabs in a workspace. Returns each tab's id, label, number, pane count, and focus.",
		promptSnippet: "List herdr tabs and their pane counts",
		promptGuidelines: [
			"Use herdr_list_tabs to enumerate tabs (optionally filtered by workspaceId).",
		],
		parameters: Type.Object({
			workspaceId: Type.Optional(
				Type.String({ description: "Limit to a workspace id (e.g. 'w1')." }),
			),
		}),
		async execute(_id, p, signal) {
			const r = await herdr<{ tabs?: unknown[] }>(
				listTabsArgs({ workspaceId: p.workspaceId }),
				{ timeoutMs: 10_000, signal },
			);
			if (!r.ok) return fail(r);
			const tabs = (r.data?.tabs ?? []).map(normalizeTab);
			return okText(
				tabs.length
					? `${tabs.length} tab(s):\n` +
							tabs
								.map(
									(t) =>
										`- ${t.tabId ?? "?"} #${t.number ?? "?"} "${t.label ?? ""}" ${t.paneCount ?? 0} pane(s)${t.focused ? " (focused)" : ""}`,
								)
								.join("\n")
					: "No tabs.",
				{ tabs },
			);
		},
	});

	// 8. create_tab ----------------------------------------------------------
	pi.registerTool({
		name: "herdr_create_tab",
		label: "Create herdr tab",
		description:
			"Create a new tab (optionally in a specific workspace, with a cwd/label/env, focused or not). Returns the new tab id.",
		promptSnippet: "Create a new herdr tab and get its id",
		promptGuidelines: [
			"Use herdr_create_tab to add a tab to a workspace; optionally set cwd/label/env and focus.",
		],
		parameters: Type.Object({
			workspaceId: Type.Optional(
				Type.String({
					description: "Workspace to create the tab in (default: current).",
				}),
			),
			cwd: Type.Optional(
				Type.String({ description: "Working directory for the tab's shell." }),
			),
			label: Type.Optional(Type.String({ description: "Tab label." })),
			env: Type.Optional(
				Type.Record(Type.String(), Type.String(), {
					description: "Extra env vars (KEY=VALUE) for the tab's shell.",
				}),
			),
			focus: Type.Optional(
				Type.Boolean({
					description: "Focus the new tab (default herdr-determined).",
				}),
			),
		}),
		async execute(_id, p, signal) {
			const r = await herdr<unknown>(
				createTabArgs({
					workspaceId: p.workspaceId,
					cwd: p.cwd ?? process.cwd(),
					label: p.label,
					env: p.env,
					focus: p.focus,
				}),
				{ timeoutMs: 15_000, signal },
			);
			if (!r.ok) return fail(r);
			const tabId = extractId(r.data, ["tab_id", "tabId"], "tab");
			if (!tabId)
				return fail(
					err("PANE_GONE", "herdr tab create returned no tab id", r.data),
				);
			return okText(`Created tab ${tabId}.`, { tabId });
		},
	});

	// 9. get_tab -------------------------------------------------------------
	pi.registerTool({
		name: "herdr_get_tab",
		label: "Get herdr tab",
		description: "Show details of a single tab by id.",
		promptSnippet: "Get one tab's details",
		promptGuidelines: [
			"Use herdr_get_tab to inspect a tab (label, number, pane count, workspace, focus) by id.",
		],
		parameters: Type.Object({
			tabId: Type.String({ description: "Tab id (e.g. 'w1:t1')." }),
		}),
		async execute(_id, p, signal) {
			const r = await herdr<{ tab?: Record<string, unknown> }>(
				["tab", "get", p.tabId],
				{ timeoutMs: 10_000, signal },
			);
			if (!r.ok) return fail(r);
			const t = normalizeTab(r.data?.tab ?? r.data);
			return okText(
				`Tab ${t.tabId ?? p.tabId}: #${t.number ?? "?"} "${t.label ?? ""}" ${t.paneCount ?? 0} pane(s) workspace=${t.workspaceId ?? "?"}${t.focused ? " (focused)" : ""}.`,
				t,
			);
		},
	});

	// 10. focus_tab ----------------------------------------------------------
	pi.registerTool({
		name: "herdr_focus_tab",
		label: "Focus herdr tab",
		description: "Focus a tab in the herdr UI.",
		promptSnippet: "Focus a herdr tab",
		promptGuidelines: ["Use herdr_focus_tab to switch the focused tab by id."],
		parameters: Type.Object({
			tabId: Type.String({ description: "Tab id to focus." }),
		}),
		async execute(_id, p, signal) {
			const r = await herdr(["tab", "focus", p.tabId], {
				timeoutMs: 10_000,
				signal,
			});
			if (!r.ok) return fail(r);
			return okText(`Focused tab ${p.tabId}.`, { tabId: p.tabId, focused: true });
		},
	});

	// 11. rename_tab ---------------------------------------------------------
	pi.registerTool({
		name: "herdr_rename_tab",
		label: "Rename herdr tab",
		description: "Rename a tab.",
		promptSnippet: "Rename a herdr tab",
		promptGuidelines: ["Use herdr_rename_tab to change a tab's label by id."],
		parameters: Type.Object({
			tabId: Type.String({ description: "Tab id to rename." }),
			label: Type.String({ description: "New tab label." }),
		}),
		async execute(_id, p, signal) {
			if (!p.label?.length)
				return fail(err("VALIDATION_ERROR", "'label' must be a non-empty string."));
			const r = await herdr(["tab", "rename", p.tabId, p.label], {
				timeoutMs: 10_000,
				signal,
			});
			if (!r.ok) return fail(r);
			return okText(`Renamed tab ${p.tabId} -> "${p.label}".`, {
				tabId: p.tabId,
				label: p.label,
			});
		},
	});

	// 12. close_tab (destructive) -------------------------------------------
	pi.registerTool({
		name: "herdr_close_tab",
		label: "Close herdr tab",
		description:
			"⚠️ Destructive. Close a tab by id (terminates every pane in it).",
		promptSnippet: "Close a herdr tab by id (destructive)",
		promptGuidelines: [
			"Use herdr_close_tab to remove a tab; it closes all panes inside it.",
		],
		parameters: Type.Object({
			tabId: Type.String({ description: "Tab id to close." }),
		}),
		async execute(_id, p, signal) {
			const r = await herdr(["tab", "close", p.tabId], {
				timeoutMs: 10_000,
				signal,
			});
			if (!r.ok) return fail(r);
			return okText(`Closed tab ${p.tabId}.`, { tabId: p.tabId, closed: true });
		},
	});

	// ===================== WORKSPACES =======================================

	// 13. list_workspaces ----------------------------------------------------
	pi.registerTool({
		name: "herdr_list_workspaces",
		label: "List herdr workspaces",
		description:
			"List all workspaces. Returns each workspace's id, label, number, tab/pane counts, active tab, and focus.",
		promptSnippet: "List herdr workspaces and their tab/pane counts",
		promptGuidelines: [
			"Use herdr_list_workspaces to enumerate every workspace and its active tab.",
		],
		parameters: Type.Object({}),
		async execute(_id, _p, signal) {
			const r = await herdr<{ workspaces?: unknown[] }>(["workspace", "list"], {
				timeoutMs: 10_000,
				signal,
			});
			if (!r.ok) return fail(r);
			const workspaces = (r.data?.workspaces ?? []).map(normalizeWorkspace);
			return okText(
				workspaces.length
					? `${workspaces.length} workspace(s):\n` +
							workspaces
								.map(
									(w) =>
										`- ${w.workspaceId ?? "?"} #${w.number ?? "?"} "${w.label ?? ""}" ${w.tabCount ?? 0} tab(s)/${w.paneCount ?? 0} pane(s) active=${w.activeTabId ?? "?"}${w.focused ? " (focused)" : ""}`,
								)
								.join("\n")
					: "No workspaces.",
				{ workspaces },
			);
		},
	});

	// 14. create_workspace ---------------------------------------------------
	pi.registerTool({
		name: "herdr_create_workspace",
		label: "Create herdr workspace",
		description:
			"Create a new workspace (optionally with a cwd/label/env, focused or not). Returns the new workspace id.",
		promptSnippet: "Create a new herdr workspace and get its id",
		promptGuidelines: [
			"Use herdr_create_workspace to add a workspace; optionally set cwd/label/env and focus.",
		],
		parameters: Type.Object({
			cwd: Type.Optional(
				Type.String({ description: "Working directory for the workspace." }),
			),
			label: Type.Optional(Type.String({ description: "Workspace label." })),
			env: Type.Optional(
				Type.Record(Type.String(), Type.String(), {
					description: "Extra env vars (KEY=VALUE) for the workspace.",
				}),
			),
			focus: Type.Optional(
				Type.Boolean({
					description: "Focus the new workspace (default herdr-determined).",
				}),
			),
		}),
		async execute(_id, p, signal) {
			const r = await herdr<unknown>(
				createWorkspaceArgs({
					cwd: p.cwd ?? process.cwd(),
					label: p.label,
					env: p.env,
					focus: p.focus,
				}),
				{ timeoutMs: 15_000, signal },
			);
			if (!r.ok) return fail(r);
			const workspaceId = extractId(
				r.data,
				["workspace_id", "workspaceId"],
				"workspace",
			);
			if (!workspaceId)
				return fail(
					err(
						"PANE_GONE",
						"herdr workspace create returned no workspace id",
						r.data,
					),
				);
			return okText(`Created workspace ${workspaceId}.`, { workspaceId });
		},
	});

	// 15. get_workspace ------------------------------------------------------
	pi.registerTool({
		name: "herdr_get_workspace",
		label: "Get herdr workspace",
		description: "Show details of a single workspace by id.",
		promptSnippet: "Get one workspace's details",
		promptGuidelines: [
			"Use herdr_get_workspace to inspect a workspace (label, number, tab/pane counts, active tab, focus) by id.",
		],
		parameters: Type.Object({
			workspaceId: Type.String({ description: "Workspace id (e.g. 'w1')." }),
		}),
		async execute(_id, p, signal) {
			const r = await herdr<{ workspace?: Record<string, unknown> }>(
				["workspace", "get", p.workspaceId],
				{ timeoutMs: 10_000, signal },
			);
			if (!r.ok) return fail(r);
			const w = normalizeWorkspace(r.data?.workspace ?? r.data);
			return okText(
				`Workspace ${w.workspaceId ?? p.workspaceId}: #${w.number ?? "?"} "${w.label ?? ""}" ${w.tabCount ?? 0} tab(s)/${w.paneCount ?? 0} pane(s) active=${w.activeTabId ?? "?"}${w.focused ? " (focused)" : ""}.`,
				w,
			);
		},
	});

	// 16. focus_workspace ----------------------------------------------------
	pi.registerTool({
		name: "herdr_focus_workspace",
		label: "Focus herdr workspace",
		description: "Focus a workspace in the herdr UI.",
		promptSnippet: "Focus a herdr workspace",
		promptGuidelines: [
			"Use herdr_focus_workspace to switch the focused workspace by id.",
		],
		parameters: Type.Object({
			workspaceId: Type.String({ description: "Workspace id to focus." }),
		}),
		async execute(_id, p, signal) {
			const r = await herdr(["workspace", "focus", p.workspaceId], {
				timeoutMs: 10_000,
				signal,
			});
			if (!r.ok) return fail(r);
			return okText(`Focused workspace ${p.workspaceId}.`, {
				workspaceId: p.workspaceId,
				focused: true,
			});
		},
	});

	// 17. rename_workspace ---------------------------------------------------
	pi.registerTool({
		name: "herdr_rename_workspace",
		label: "Rename herdr workspace",
		description: "Rename a workspace.",
		promptSnippet: "Rename a herdr workspace",
		promptGuidelines: [
			"Use herdr_rename_workspace to change a workspace's label by id.",
		],
		parameters: Type.Object({
			workspaceId: Type.String({ description: "Workspace id to rename." }),
			label: Type.String({ description: "New workspace label." }),
		}),
		async execute(_id, p, signal) {
			if (!p.label?.length)
				return fail(err("VALIDATION_ERROR", "'label' must be a non-empty string."));
			const r = await herdr(["workspace", "rename", p.workspaceId, p.label], {
				timeoutMs: 10_000,
				signal,
			});
			if (!r.ok) return fail(r);
			return okText(`Renamed workspace ${p.workspaceId} -> "${p.label}".`, {
				workspaceId: p.workspaceId,
				label: p.label,
			});
		},
	});

	// 18. close_workspace (destructive) -------------------------------------
	pi.registerTool({
		name: "herdr_close_workspace",
		label: "Close herdr workspace",
		description:
			"⚠️ Destructive. Close a workspace by id (terminates every tab and pane in it).",
		promptSnippet: "Close a herdr workspace by id (destructive)",
		promptGuidelines: [
			"Use herdr_close_workspace to remove a workspace; it closes all tabs and panes inside it.",
		],
		parameters: Type.Object({
			workspaceId: Type.String({ description: "Workspace id to close." }),
		}),
		async execute(_id, p, signal) {
			const r = await herdr(["workspace", "close", p.workspaceId], {
				timeoutMs: 10_000,
				signal,
			});
			if (!r.ok) return fail(r);
			return okText(`Closed workspace ${p.workspaceId}.`, {
				workspaceId: p.workspaceId,
				closed: true,
			});
		},
	});
}
