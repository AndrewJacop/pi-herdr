// The /herdr command: one flat interactive settings menu plus the confirmed
// Kill-all-agents action. Bare form only — there is deliberately NO
// `/herdr set key value` args form: settings are user knobs (the model must
// not flip allow_save_agent mid-session); hand-editing the JSON files stays
// the scriptable path.
//
// Row shape: `key = value (source: project | global | default)`, ordered
// safety gates → behavior, then the Kill-all action row. Bool rows toggle,
// enum rows pick, number rows input, and each write persists to whichever
// file owns the key (a default-sourced key writes the project file) — a
// project checkout never mutates global config.
//
// Decided by wayfinder ticket 03 — settings menu.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentKinds } from "./config.js";
import { herdr } from "./herdr.js";
import { normalizeAgent } from "./env.js";
import {
	SETTING_KEYS,
	getSettingsPaths,
	loadSettings,
	type JsonObject,
	type ResolvedSettings,
	type SettingKeyDef,
	type SettingValue,
	type SettingsPaths,
	writeSetting,
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

export function registerHerdrCommand(pi: ExtensionAPI): void {
	pi.registerCommand("herdr", {
		description:
			"herdr settings menu (agent gates, surface, limits) + Kill all agents",
		handler: async (_args, ctx) => {
			// Bare form only: args are ignored on purpose — there is no
			// `/herdr set key value` form. Dialogs need a UI.
			if (!ctx.hasUI) return;
			await runSettingsMenu(ctx);
		},
	});
}

/** Render one row: `key = value (source: …)` (+ restart note for `surface`). */
export function formatSettingRow(
	def: SettingKeyDef,
	resolved: ResolvedSettings,
): string {
	const value = resolved.effective[def.key];
	const source = resolved.sources[def.key];
	const restart = def.restartRequired ? " — restart required (/reload)" : "";
	return `${def.key} = ${value} (source: ${source})${restart}`;
}

/**
 * Run the settings menu loop until the user picks Done/cancels. Each pass
 * re-reads both files (hot-reload semantics: the six read-at-use keys are
 * always current; `surface` shows a restart-required note instead).
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
		const choice = await ctx.ui.select("herdr settings", [
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

/** Edit one setting by its type: toggle / pick / input, then persist. */
async function editSetting(
	ctx: MenuContext,
	def: SettingKeyDef,
	resolved: ResolvedSettings,
	paths: SettingsPaths,
	kindsFn: typeof getAgentKinds,
): Promise<void> {
	const current = resolved.effective[def.key];

	let next: SettingValue | null = null;
	if (def.type === "bool") {
		next = !current;
	} else if (def.type === "enum") {
		const values = def.values ?? [];
		const pick = await ctx.ui.select(`${def.key} — ${def.description}`, [
			...values,
		]);
		if (pick === undefined) return; // cancelled
		next = pick;
	} else if (def.type === "number") {
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
		next = n;
	} else {
		// default_kind: free string in the schema, validated against the live
		// kind list when picked (the authoritative check happens at spawn).
		const kinds = await kindsFn();
		const pick = await ctx.ui.select(`${def.key} — ${def.description}`, kinds);
		if (pick === undefined) return; // cancelled
		next = pick;
	}

	// The write goes to whichever file owns the key — never a target prompt.
	// A default-sourced key lands in the project file, so a project checkout
	// never mutates global config.
	const target =
		resolved.sources[def.key] === "global" ? paths.globalPath : paths.projectPath;
	const r = writeSetting(target, def.key, next);
	if (r.ok) {
		ctx.ui.notify(`${def.key} = ${next} saved to ${r.path}`, "info");
	} else {
		ctx.ui.notify(r.error, "error");
	}
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
