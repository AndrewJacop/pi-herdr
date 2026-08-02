// Tier 4 — Git worktree helpers.
//
// herdr 0.7.5 exposes `worktree create/open/list/remove` over the socket API:
// spin up a parallel checkout of the current repo (optionally on a branch based
// off a ref) and open it as its own workspace, list the linked checkouts, or
// tear one down. `worktree remove` is destructive (it deletes the checkout dir)
// and is labeled ⚠️.
//
// Each tool is a thin wrapper: build argv -> herdr() -> uniform ToolReturn,
// mirroring orchestration.ts / sync.ts / layout.ts. The argv builders are pure
// (no I/O) so the branching logic is unit-testable offline (`tests/smoke.mjs`).
// These commands target the herdr 0.7.5 surface directly (they don't exist on
// <0.7.5); a legacy build surfaces the server-side error. `--json` is always
// emitted so the envelope parser returns structured data.

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

function pickBool(
	o: Record<string, unknown>,
	...keys: string[]
): boolean | undefined {
	for (const k of keys) {
		if (typeof o[k] === "boolean") return o[k] as boolean;
	}
	return undefined;
}

/** Expand a focus boolean into the matching herdr flag (omitted when undefined). */
function focusFlag(focus: boolean | undefined): string[] {
	if (focus === true) return ["--focus"];
	if (focus === false) return ["--no-focus"];
	return [];
}

// ---- normalizers ----------------------------------------------------------

export interface NormalizedWorktree {
	path?: string;
	branch?: string;
	label?: string;
	openWorkspaceId?: string;
	isLinkedWorktree?: boolean;
	isDetached?: boolean;
	isBare?: boolean;
	isPrunable?: boolean;
}
/**
 * Normalize a raw herdr worktree object (snake_case) into the camelCase contract.
 * Tolerates `open_workspace_id` (opened worktree) and a bare `workspace_id`.
 */
export function normalizeWorktree(w: unknown): NormalizedWorktree {
	if (!w || typeof w !== "object") return {};
	const o = w as Record<string, unknown>;
	return {
		path: pickStr(o, "path"),
		branch: pickStr(o, "branch"),
		label: pickStr(o, "label"),
		openWorkspaceId: pickStr(
			o,
			"open_workspace_id",
			"openWorkspaceId",
			"workspace_id",
			"workspaceId",
		),
		isLinkedWorktree: pickBool(o, "is_linked_worktree", "isLinkedWorktree"),
		isDetached: pickBool(o, "is_detached", "isDetached"),
		isBare: pickBool(o, "is_bare", "isBare"),
		isPrunable: pickBool(o, "is_prunable", "isPrunable"),
	};
}

/**
 * Tolerantly pull a single worktree out of a `worktree create` / `worktree open`
 * result: it may be a bare worktree object, wrapped under `worktree`, or the
 * first element of a `worktrees` array. Returns the normalized fields.
 */
export function extractWorktree(d: unknown): NormalizedWorktree {
	if (!d || typeof d !== "object") return {};
	const o = d as Record<string, unknown>;
	if (Array.isArray(o.worktrees) && o.worktrees.length) {
		return normalizeWorktree(o.worktrees[0]);
	}
	if (o.worktree && typeof o.worktree === "object") {
		return normalizeWorktree(o.worktree);
	}
	return normalizeWorktree(o);
}

// ---- pure argv builders (unit-testable offline) ----------------------------

/** `worktree create [--workspace] [--cwd] [--branch] [--base] [--path] [--label] [--focus|--no-focus] --json` */
export function createWorktreeArgs(opts: {
	workspaceId?: string;
	cwd?: string;
	branch?: string;
	base?: string;
	path?: string;
	label?: string;
	focus?: boolean;
}): string[] {
	const args = ["worktree", "create"];
	if (opts.workspaceId) args.push("--workspace", opts.workspaceId);
	if (opts.cwd) args.push("--cwd", opts.cwd);
	if (opts.branch) args.push("--branch", opts.branch);
	if (opts.base) args.push("--base", opts.base);
	if (opts.path) args.push("--path", opts.path);
	if (opts.label) args.push("--label", opts.label);
	args.push(...focusFlag(opts.focus));
	args.push("--json");
	return args;
}

/** `worktree open [--workspace] [--cwd] [--path] [--branch] [--label] [--focus|--no-focus] --json` */
export function openWorktreeArgs(opts: {
	workspaceId?: string;
	cwd?: string;
	path?: string;
	branch?: string;
	label?: string;
	focus?: boolean;
}): string[] {
	const args = ["worktree", "open"];
	if (opts.workspaceId) args.push("--workspace", opts.workspaceId);
	if (opts.cwd) args.push("--cwd", opts.cwd);
	if (opts.path) args.push("--path", opts.path);
	if (opts.branch) args.push("--branch", opts.branch);
	if (opts.label) args.push("--label", opts.label);
	args.push(...focusFlag(opts.focus));
	args.push("--json");
	return args;
}

/** `worktree list [--workspace] [--cwd] --json` */
export function listWorktreesArgs(opts: {
	workspaceId?: string;
	cwd?: string;
} = {}): string[] {
	const args = ["worktree", "list"];
	if (opts.workspaceId) args.push("--workspace", opts.workspaceId);
	if (opts.cwd) args.push("--cwd", opts.cwd);
	args.push("--json");
	return args;
}

/** `worktree remove [--workspace] [--force] --json` */
export function removeWorktreeArgs(opts: {
	workspaceId?: string;
	force?: boolean;
}): string[] {
	const args = ["worktree", "remove"];
	if (opts.workspaceId) args.push("--workspace", opts.workspaceId);
	if (opts.force) args.push("--force");
	args.push("--json");
	return args;
}

// ---- registration ----------------------------------------------------------

export function registerWorktrees(pi: ExtensionAPI): void {
	// 1. worktree_create -----------------------------------------------------
	pi.registerTool({
		name: "herdr_worktree_create",
		label: "Create herdr worktree",
		description:
			"Create a Git worktree (parallel checkout, optionally on a new branch based off a ref) and open it as a workspace. " +
			"Returns the worktree path, branch, and opened workspace id.",
		promptSnippet: "Create and open a Git worktree as a workspace",
		promptGuidelines: [
			"Use herdr_worktree_create to spin up a parallel repo checkout (optionally a new branch off a base ref); pair with herdr_worktree_list to see linked checkouts.",
		],
		parameters: Type.Object({
			workspaceId: Type.Optional(
				Type.String({
					description: "Create the worktree in this workspace (default: current).",
				}),
			),
			cwd: Type.Optional(
				Type.String({
					description: "Source repo path to create the worktree from (default: cwd).",
				}),
			),
			branch: Type.Optional(
				Type.String({
					description: "Branch name for the new worktree (created from --base).",
				}),
			),
			base: Type.Optional(
				Type.String({
					description: "Git ref to base the new branch on (e.g. 'main', a SHA).",
				}),
			),
			path: Type.Optional(
				Type.String({ description: "Explicit checkout path for the worktree." }),
			),
			label: Type.Optional(
				Type.String({ description: "Label for the opened workspace." }),
			),
			focus: Type.Optional(
				Type.Boolean({ description: "Focus the opened workspace (default herdr-determined)." }),
			),
		}),
		async execute(_id, p, signal) {
			const r = await herdr<unknown>(
				createWorktreeArgs({
					workspaceId: p.workspaceId,
					cwd: p.cwd,
					branch: p.branch,
					base: p.base,
					path: p.path,
					label: p.label,
					focus: p.focus,
				}),
				{ timeoutMs: 60_000, signal },
			);
			if (!r.ok) return fail(r);
			const w = extractWorktree(r.data);
			return okText(
				`Created worktree${w.branch ? ` on '${w.branch}'` : ""}${w.path ? ` at ${w.path}` : ""}${w.openWorkspaceId ? ` (workspace ${w.openWorkspaceId})` : ""}.`,
				w,
			);
		},
	});

	// 2. worktree_open -------------------------------------------------------
	pi.registerTool({
		name: "herdr_worktree_open",
		label: "Open herdr worktree",
		description:
			"Open an existing Git worktree as a workspace (by path or branch). " +
			"Returns the worktree path and opened workspace id.",
		promptSnippet: "Open an existing Git worktree as a workspace",
		promptGuidelines: [
			"Use herdr_worktree_open to open a checkout that already exists on disk; use herdr_worktree_create to make a new one.",
		],
		parameters: Type.Object({
			workspaceId: Type.Optional(
				Type.String({
					description: "Open the worktree in this workspace (default: current).",
				}),
			),
			cwd: Type.Optional(
				Type.String({
					description: "Source repo path the worktree belongs to (default: cwd).",
				}),
			),
			path: Type.Optional(
				Type.String({ description: "Checkout path of the existing worktree." }),
			),
			branch: Type.Optional(
				Type.String({ description: "Branch of the worktree to open." }),
			),
			label: Type.Optional(
				Type.String({ description: "Label for the opened workspace." }),
			),
			focus: Type.Optional(
				Type.Boolean({ description: "Focus the opened workspace (default herdr-determined)." }),
			),
		}),
		async execute(_id, p, signal) {
			const r = await herdr<unknown>(
				openWorktreeArgs({
					workspaceId: p.workspaceId,
					cwd: p.cwd,
					path: p.path,
					branch: p.branch,
					label: p.label,
					focus: p.focus,
				}),
				{ timeoutMs: 30_000, signal },
			);
			if (!r.ok) return fail(r);
			const w = extractWorktree(r.data);
			return okText(
				`Opened worktree${w.branch ? ` '${w.branch}'` : ""}${w.path ? ` at ${w.path}` : ""}${w.openWorkspaceId ? ` (workspace ${w.openWorkspaceId})` : ""}.`,
				w,
			);
		},
	});

	// 3. worktree_list -------------------------------------------------------
	pi.registerTool({
		name: "herdr_worktree_list",
		label: "List herdr worktrees",
		description:
			"List Git worktree checkouts for a repo (the main checkout plus linked worktrees). " +
			"Returns each worktree's path, branch, label, and opened workspace id (if any).",
		promptSnippet: "List Git worktree checkouts and their opened workspaces",
		promptGuidelines: [
			"Use herdr_worktree_list to enumerate linked repo checkouts; see which are opened as workspaces before herdr_worktree_remove.",
		],
		parameters: Type.Object({
			workspaceId: Type.Optional(
				Type.String({
					description: "Resolve the repo from this workspace (default: current).",
				}),
			),
			cwd: Type.Optional(
				Type.String({
					description: "Source repo path to list worktrees for (default: cwd).",
				}),
			),
		}),
		async execute(_id, p, signal) {
			const r = await herdr<{ worktrees?: unknown[] }>(
				listWorktreesArgs({
					workspaceId: p.workspaceId,
					cwd: p.cwd,
				}),
				{ timeoutMs: 20_000, signal },
			);
			if (!r.ok) return fail(r);
			const worktrees = (r.data?.worktrees ?? []).map(normalizeWorktree);
			return okText(
				worktrees.length
					? `${worktrees.length} worktree(s):\n` +
						worktrees
							.map(
								(w) =>
									`- ${w.branch ?? "?"}${w.path ? ` @ ${w.path}` : ""}${w.openWorkspaceId ? ` (open: ${w.openWorkspaceId})` : ""}${w.label && w.label !== w.branch ? ` "${w.label}"` : ""}`,
							)
							.join("\n")
					: "No worktrees.",
				{ worktrees },
			);
		},
	});

	// 4. worktree_remove (destructive) --------------------------------------
	// `worktree remove` deletes the checkout directory (and the branch link).
	// Labeled ⚠️ because it removes files on disk. `--force` is required to remove
	// a worktree with uncommitted changes; the tool exposes it explicitly.
	pi.registerTool({
		name: "herdr_worktree_remove",
		label: "Remove herdr worktree",
		description:
			"⚠️ Destructive. Remove a Git worktree checkout (deletes the checkout directory). " +
			"Set force to remove a worktree with uncommitted changes.",
		promptSnippet: "Remove a Git worktree checkout (destructive)",
		promptGuidelines: [
			"Use herdr_worktree_remove to tear down a worktree (⚠️ deletes its checkout dir); list first with herdr_worktree_list and prefer force:false.",
		],
		parameters: Type.Object({
			workspaceId: Type.Optional(
				Type.String({
					description: "Resolve the worktree to remove from this workspace (default: current).",
				}),
			),
			force: Type.Optional(
				Type.Boolean({
					description: "Remove even with uncommitted changes / when not otherwise removable (default false).",
				}),
			),
		}),
		async execute(_id, p, signal) {
			const r = await herdr(
				removeWorktreeArgs({
					workspaceId: p.workspaceId,
					force: p.force,
				}),
				{ timeoutMs: 30_000, signal },
			);
			if (!r.ok) return fail(r);
			return okText(
				`Removed worktree${p.workspaceId ? ` in ${p.workspaceId}` : ""}${p.force ? " (--force)" : ""}.`,
				{ workspaceId: p.workspaceId, force: Boolean(p.force), removed: true },
			);
		},
	});
}
