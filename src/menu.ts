// The /subagents command: one flat interactive settings menu plus the confirmed
// Kill-all-agents action. `/subagents config` and bare `/subagents` both open
// the menu (the arg word is optional; future sibling words can grow, an
// unknown word is answered with a pointer). There is deliberately NO
// `/subagents set key value` args form: settings are user knobs (the model
// must not flip the kill switch mid-session); hand-editing the JSON files
// stays the scriptable path.
//
// Row shape: `key = value (source: project | global | default)`, ordered
// safety gate → behavior, then the Kill-all action row. Bool rows toggle,
// enum rows pick, number rows input, string rows input (default_kind picks
// from the live kind list), and the models.agents record row edits one
// agent-name pin at a time. Each write persists to whichever file owns the
// key (a default-sourced key writes the project file) — a project checkout
// never mutates global config.
//
// Decided by wayfinder tickets 03 + 09 — settings menu, surface cut.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentKinds } from "./config.js";
import { herdr } from "./herdr.js";
import { normalizeAgent } from "./env.js";
import {
	SETTING_KEYS,
	getSettingsPaths,
	loadSettings,
	readSettingValue,
	writeRecordEntry,
	writeSetting,
	type JsonObject,
	type ResolvedSettings,
	type SettingKeyDef,
	type SettingValue,
	type SettingsPaths,
} from "./settings.js";

/** The UI + cwd surface runSettingsMenu needs — structurally satisfied by the
 *  real ExtensionCommandContext, mockable in tests. */
export interface MenuContext {
	cwd: string;
	hasUI: boolean;
	ui: {
		select(title: string, options: string[]): Promise<string | undefined>;
		confirm(title: string, message: string): Promise<boolean>;
		input(title: string, placeholder?: string): Promise<string | undefined>;
		notify(message: string, type?: "info" | "warning" | "error"): void;
	};
}

/** Injectable seams so tests can drive the menu without herdr or real files. */
export interface MenuDeps {
	paths?: SettingsPaths;
	herdrFn?: typeof herdr;
	kindsFn?: typeof getAgentKinds;
}

const KILL_ALL_ROW = "Kill all agents";
const DONE_ROW = "Done (close menu)";
const MENU_TITLE = "subagents config";

export function registerSubagentsCommand(pi: ExtensionAPI): void {
	pi.registerCommand("subagents", {
		description:
			"subagents config — settings menu (agent gates, model routing, limits) + Kill all agents",
		handler: async (args, ctx) => {
			// Bare form and `/subagents config` both open the menu; an unknown
			// sibling word is answered with a pointer (words can grow later).
			// Dialogs need a UI.
			if (!ctx.hasUI) return;
			const word = (args ?? "").trim().split(/\s+/)[0] ?? "";
			if (word && word !== "config") {
				ctx.ui.notify(
					`Unknown /subagents ${word} — try /subagents config`,
					"warning",
				);
				return;
			}
			await runSettingsMenu(ctx);
		},
	});
}

/** Render one row's value: records compactly, scalars as-is. */
function renderValue(value: SettingValue): string {
	if (typeof value === "object" && value !== null && !Array.isArray(value)) {
		const entries = Object.entries(value);
		if (entries.length === 0) return "{}";
		return `{ ${entries.map(([n, m]) => `${n}: ${m}`).join(", ")} }`;
	}
	return value === "" ? "(unset)" : String(value);
}

/** Render one row: `key = value (source: …)` (+ restart note when cached). */
export function formatSettingRow(
	def: SettingKeyDef,
	resolved: ResolvedSettings,
): string {
	const value = readSettingValue(resolved.effective, def);
	const source = resolved.sources[def.key];
	const restart = def.restartRequired ? " — restart required (/reload)" : "";
	return `${def.key} = ${renderValue(value)} (source: ${source})${restart}`;
}

/**
 * Run the settings menu loop until the user picks Done/cancels. Each pass
 * re-reads both files (hot-reload semantics: every key is read at use).
 */
export async function runSettingsMenu(
	ctx: MenuContext,
	deps: MenuDeps = {},
): Promise<void> {
	const paths = deps.paths ?? getSettingsPaths(ctx.cwd);
	const herdrFn = deps.herdrFn ?? herdr;
	const kindsFn = deps.kindsFn ?? getAgentKinds;

	let lastIssueCount = 0;
	for (;;) {
		const resolved = loadSettings(paths);
		// Surface file problems honestly, but only once each (the loop
		// re-renders after every edit).
		for (const issue of resolved.issues.slice(lastIssueCount)) {
			ctx.ui.notify(`${issue.path}: ${issue.problem}`, "warning");
		}
		lastIssueCount = resolved.issues.length;

		const rowToKey = new Map<string, SettingKeyDef>();
		for (const def of SETTING_KEYS) {
			rowToKey.set(formatSettingRow(def, resolved), def);
		}
		const choice = await ctx.ui.select(MENU_TITLE, [
			...rowToKey.keys(),
			KILL_ALL_ROW,
			DONE_ROW,
		]);
		if (!choice || choice === DONE_ROW) return;

		if (choice === KILL_ALL_ROW) {
			await killAllAgents(ctx, herdrFn);
			continue;
		}
		const def = rowToKey.get(choice);
		if (!def) continue;
		await editSetting(ctx, def, resolved, paths, kindsFn);
	}
}

/**
 * Edit one setting by its type: toggle / pick / input / record-entry, then
 * persist. An `input` returning undefined cancels; an EMPTY submitted string
 * clears where clearing is meaningful (models.default unset, record pin
 * removed) and is rejected where it isn't (default_kind).
 */
async function editSetting(
	ctx: MenuContext,
	def: SettingKeyDef,
	resolved: ResolvedSettings,
	paths: SettingsPaths,
	kindsFn: typeof getAgentKinds,
): Promise<void> {
	const current = readSettingValue(resolved.effective, def);
	const target =
		resolved.sources[def.key] === "global" ? paths.globalPath : paths.projectPath;

	if (def.type === "bool") {
		const r = writeSetting(target, def.key, !current);
		notifyWrite(ctx, def.key, !current, r);
		return;
	}

	if (def.type === "enum") {
		const pick = await ctx.ui.select(`${def.key} — ${def.description}`, [
			...(def.values ?? []),
		]);
		if (pick === undefined) return; // cancelled
		const r = writeSetting(target, def.key, pick);
		notifyWrite(ctx, def.key, pick, r);
		return;
	}

	if (def.type === "number") {
		const raw = await ctx.ui.input(
			`${def.key} — ${def.description}`,
			String(current),
		);
		if (raw === undefined) return; // cancelled
		const n = Number(raw.trim());
		if (!Number.isInteger(n) || n < (def.min ?? 1)) {
			ctx.ui.notify(
				`${def.key}: "${raw.trim()}" is not an integer >= ${def.min ?? 1} — not saved`,
				"error",
			);
			return;
		}
		const r = writeSetting(target, def.key, n);
		notifyWrite(ctx, def.key, n, r);
		return;
	}

	if (def.type === "record") {
		// One agent-name pin at a time: name → model. Empty model removes the
		// pin. The effective record is the per-name merge of BOTH files, so a
		// removal clears the entry from each file that has it — removing only
		// from the owning file would let a same-named global pin silently win.
		const name = await ctx.ui.input(
			`${def.key} — ${def.description}`,
			"agent name (empty to cancel)",
		);
		if (name === undefined || name.trim() === "") return; // cancelled
		const agent = name.trim();
		const pinned =
			typeof current === "object" && current !== null
				? (current as Record<string, string>)[agent]
				: undefined;
		const model = await ctx.ui.input(
			`model id for "${agent}"${pinned ? ` (currently ${pinned})` : ""} — empty removes the pin`,
			pinned ?? "provider/model-id",
		);
		if (model === undefined) return; // cancelled
		const trimmed = model.trim();
		if (trimmed === "" && !pinned) {
			ctx.ui.notify(`${agent}: nothing to remove — not saved`, "info");
			return;
		}
		if (trimmed === "") {
			const removals = [paths.projectPath, paths.globalPath].map((p) =>
				writeRecordEntry(p, def.key, agent, null),
			);
			const failure = removals.find((x) => !x.ok);
			if (failure && !failure.ok) {
				ctx.ui.notify(failure.error, "error");
			} else {
				ctx.ui.notify(`${def.key}: removed pin for ${agent}`, "info");
			}
			return;
		}
		const r = writeRecordEntry(target, def.key, agent, trimmed);
		notifyResult(
			ctx,
			(p) => `${def.key}: ${agent} = ${trimmed} saved to ${p}`,
			r,
		);
		return;
	}

	// type === "string"
	if (def.editor === "kinds") {
		// default_kind: free string in the schema, validated against the live
		// kind list when picked (the authoritative check happens at spawn).
		const kinds = await kindsFn();
		const pick = await ctx.ui.select(`${def.key} — ${def.description}`, kinds);
		if (pick === undefined) return; // cancelled
		const r = writeSetting(target, def.key, pick);
		notifyWrite(ctx, def.key, pick, r);
		return;
	}
	// models.default: free model id; empty clears the pin (unset = routing
	// falls through to the parent session's model — absence, not a sentinel).
	const raw = await ctx.ui.input(
		`${def.key} — ${def.description}`,
		String(current) || "provider/model-id (empty to unset)",
	);
	if (raw === undefined) return; // cancelled
	const trimmed = raw.trim();
	if (trimmed === "" && current === "") {
		ctx.ui.notify(`${def.key}: already unset — not saved`, "info");
		return;
	}
	const r = writeSetting(target, def.key, trimmed === "" ? null : trimmed);
	notifyResult(
		ctx,
		trimmed === ""
			? (p) => `${def.key} unset (removed from ${p})`
			: (p) => `${def.key} = ${trimmed} saved to ${p}`,
		r,
	);
}

/** Report a write's outcome: the success message is built from the written
 *  path (only used when the write succeeded); failures notify the error. */
function notifyResult(
	ctx: MenuContext,
	okMsg: (path: string) => string,
	r: ReturnType<typeof writeSetting>,
): void {
	if (r.ok) {
		ctx.ui.notify(okMsg(r.path), "info");
	} else {
		ctx.ui.notify(r.error, "error");
	}
}

/** Report a whole-key write's outcome. */
function notifyWrite(
	ctx: MenuContext,
	key: SettingKeyDef["key"],
	value: SettingValue | null,
	r: ReturnType<typeof writeSetting>,
): void {
	notifyResult(ctx, (p) => `${key} = ${value ?? "(unset)"} saved to ${p}`, r);
}

/**
 * The separate Kill-all action: confirm, then terminate every running agent
 * pane. This is the only thing here that terminates anything — the
 * agents_kill_switch setting is a gate on new spawns and never stops a
 * running agent.
 */
async function killAllAgents(
	ctx: MenuContext,
	herdrFn: typeof herdr,
): Promise<void> {
	const confirmed = await ctx.ui.confirm(
		"Kill all agents?",
		"Terminates every running agent pane. In-flight work is lost. Continue?",
	);
	if (!confirmed) return;

	const r = await herdrFn<{ agents?: JsonObject[] }>(["agent", "list"], {
		timeoutMs: 10_000,
	});
	if (!r.ok) {
		ctx.ui.notify(`Could not list agents: ${r.error.message}`, "error");
		return;
	}
	const agents = (r.data?.agents ?? [])
		.map((a) => normalizeAgent(a))
		.filter((a) => a.paneId);
	if (agents.length === 0) {
		ctx.ui.notify("No running agents.", "info");
		return;
	}

	let killed = 0;
	const failures: string[] = [];
	for (const a of agents) {
		// SAFETY: filter above keeps only agents with a paneId.
		const c = await herdrFn(["pane", "close", a.paneId as string], {
			timeoutMs: 10_000,
		});
		if (c.ok) killed++;
		else failures.push(`${a.name ?? a.paneId}: ${c.error.message}`);
	}
	if (failures.length > 0) {
		ctx.ui.notify(
			`Killed ${killed}/${agents.length} agents — failed: ${failures.join("; ")}`,
			"warning",
		);
	} else {
		const noun = killed === 1 ? "agent" : "agents";
		ctx.ui.notify(`Killed ${killed} ${noun}.`, "info");
	}
}
