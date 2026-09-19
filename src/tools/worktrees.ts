// Git worktree machinery — powers `isolated: true` spawns (src/spawn.ts).
//
// The v0.6 surface cut (wayfinder ticket 09) removed the worktree CRUD tools
// from the model surface; the MACHINERY survives: `createWorktreeArgs` builds
// the herdr-side worktree an isolated agent runs in, `removeWorktreeArgs` the
// teardown path, and the normalizers read the envelope back. Code deletion ≠
// capability deletion — worktree create/remove stays reachable internally;
// a user who wants to manage worktrees by hand runs `herdr worktree …` in
// their own terminal (herdr's native surface, unchanged).
//
// The argv builders are pure (no I/O) so the branching logic is unit-testable
// offline (`tests/smoke.mjs`). `--json` is always emitted so the envelope
// parser returns structured data.

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
