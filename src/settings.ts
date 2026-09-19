// Settings layer: the knobs every later ticket consults.
//
// Effective settings are the deep merge of the global file (~/.pi/agent/
// herdr.json) and the project file (<cwd>/.pi/herdr.json), with the project
// file winning per key (and, for the `models.agents` map, per agent name).
// Every resolved value tracks its source (project | global | default) so the
// /subagents config menu can annotate rows.
//
// Hot-reload model: every key is read at the moment it matters (spawn / menu /
// notify / delivery) — none is cached at init, none is restart-required.
// (`surface` died with the v0.6 surface cut: one surface, nothing to switch
// to; `allow_save_agent` died with it — save_agent lands ungated.)

import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Which file supplied a setting's effective value. */
export type SettingsSource = "project" | "global" | "default";

/** Model routing pins (`models.*` in the settings files). */
export interface ModelRoutingSettings {
	/** Routing level 4: fallback model for every agent ("" = unset). */
	default: string;
	/** Routing level 3: per-agent-name pins (name → model id). */
	agents: Record<string, string>;
}

export interface HerdrSettings {
	agents_kill_switch: boolean;
	default_kind: string;
	models: ModelRoutingSettings;
	max_parallel_agents: number;
	max_spawn_depth: number;
	notifications: "none" | "quiet" | "normal";
	idle_rearm_minutes: number;
	workflows_enabled: boolean;
}

/** Row identity — dotted names address nested file locations. */
export type SettingKey =
	| "agents_kill_switch"
	| "default_kind"
	| "models.default"
	| "models.agents.<name>"
	| "max_parallel_agents"
	| "max_spawn_depth"
	| "notifications"
	| "idle_rearm_minutes"
	| "workflows_enabled";

export type SettingValue =
	| HerdrSettings["agents_kill_switch"]
	| HerdrSettings["default_kind"]
	| HerdrSettings["max_parallel_agents"]
	| HerdrSettings["notifications"]
	| Record<string, string>;

export type SettingType = "bool" | "enum" | "number" | "string" | "record";

/** How the menu edits a string key. */
export type StringEditor = "kinds" | "free";

export interface SettingKeyDef {
	key: SettingKey;
	group: "safety" | "behavior";
	type: SettingType;
	default: SettingValue;
	/** Where the raw value lives in a settings file (nested for models.*). */
	path: readonly string[];
	/** enum choices (type: "enum"). */
	values?: readonly string[];
	/** inclusive floor (type: "number"). */
	min?: number;
	/** how the menu edits a string key (default "free"). */
	editor?: StringEditor;
	/** true when the running session caches the value; the menu marks it. */
	restartRequired?: boolean;
	description: string;
}

/**
 * The nine keys, in menu order: the safety gate first, then behavior — kind,
 * model routing, caps, notifications, and the v0.6 experience knobs.
 * (Decided by wayfinder tickets 03 + 09 — settings menu, surface cut.)
 */
export const SETTING_KEYS: readonly SettingKeyDef[] = [
	{
		key: "agents_kill_switch",
		group: "safety",
		type: "bool",
		default: false,
		path: ["agents_kill_switch"],
		description:
			"Refuse new agent spawns. A gate only — never terminates running agents.",
	},
	{
		key: "default_kind",
		group: "behavior",
		type: "string",
		default: "pi",
		path: ["default_kind"],
		editor: "kinds",
		description:
			"Agent kind spawned when none is given. Validated against the live `herdr agent` kind list.",
	},
	{
		key: "models.default",
		group: "behavior",
		type: "string",
		default: "",
		path: ["models", "default"],
		editor: "free",
		description:
			"Model id every spawned agent falls back to (routing level 4). Empty = unset — routing falls through to the parent session's model.",
	},
	{
		key: "models.agents.<name>",
		group: "behavior",
		type: "record",
		default: {},
		path: ["models", "agents"],
		description:
			"Per-agent model pins (routing level 3): agent name → model id. Entries merge across both files, project winning per name.",
	},
	{
		key: "max_parallel_agents",
		group: "behavior",
		type: "number",
		min: 1,
		default: 3,
		path: ["max_parallel_agents"],
		description:
			"Concurrency cap for running agents; spawns beyond it are queued until a slot frees.",
	},
	{
		key: "max_spawn_depth",
		group: "behavior",
		type: "number",
		min: 1,
		default: 2,
		path: ["max_spawn_depth"],
		description:
			"Maximum spawn depth; the guard against runaway recursive fleets.",
	},
	{
		key: "notifications",
		group: "behavior",
		type: "enum",
		values: ["none", "quiet", "normal"],
		default: "normal",
		path: ["notifications"],
		description: "Verbosity of agent-completion notifications.",
	},
	{
		key: "idle_rearm_minutes",
		group: "behavior",
		type: "number",
		min: 1,
		default: 15,
		path: ["idle_rearm_minutes"],
		description:
			"After a user takeover, minutes of quiet before the agent's result is auto-delivered and its pane closes. Any keystroke resets the timer.",
	},
	{
		key: "workflows_enabled",
		group: "behavior",
		type: "bool",
		default: true,
		path: ["workflows_enabled"],
		description:
			"Register the workflow tool. A gate on new workflow runs only — never stops one in flight.",
	},
];

export const DEFAULT_SETTINGS: Readonly<HerdrSettings> = Object.freeze({
	agents_kill_switch: false,
	default_kind: "pi",
	models: Object.freeze({ default: "", agents: Object.freeze({}) }),
	max_parallel_agents: 3,
	max_spawn_depth: 2,
	notifications: "normal",
	idle_rearm_minutes: 15,
	workflows_enabled: true,
});

// Tests assert every SETTING_KEYS default matches DEFAULT_SETTINGS, so the
// two can't drift.

export function settingKeyDef(key: SettingKey): SettingKeyDef {
	const def = SETTING_KEYS.find((d) => d.key === key);
	if (!def) throw new Error(`unknown setting key: ${key}`);
	return def;
}

/** Read one key's effective value out of a HerdrSettings object. */
export function readSettingValue(
	effective: HerdrSettings,
	def: SettingKeyDef,
): SettingValue {
	let cur: unknown = effective;
	for (const seg of def.path) {
		if (typeof cur !== "object" || cur === null) return def.default;
		cur = (cur as Record<string, unknown>)[seg];
	}
	return (cur ?? def.default) as SettingValue;
}

// ---- file locations ---------------------------------------------------------

export interface SettingsPaths {
	globalPath: string;
	projectPath: string;
}

/** Global + project settings file paths for a session cwd. */
export function getSettingsPaths(cwd: string): SettingsPaths {
	return {
		globalPath: join(getAgentDir(), "herdr.json"),
		projectPath: join(cwd, CONFIG_DIR_NAME, "herdr.json"),
	};
}

// ---- merge ------------------------------------------------------------------

/** A JSON value — the domain type everything post-JSON.parse narrows to. */
export type JsonValue =
	| string
	| number
	| boolean
	| null
	| JsonValue[]
	| { [key: string]: JsonValue };

/** A JSON object value. */
export type JsonObject = { [key: string]: JsonValue };

function isPlainObject(v: unknown): v is JsonObject {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function msg(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/**
 * Deep-merge two parsed settings files: plain objects merge per key, anything
 * else (scalars, arrays) is replaced. `project` wins.
 */
export function deepMerge(global: JsonValue, project: JsonValue): JsonValue {
	if (isPlainObject(global) && isPlainObject(project)) {
		const out: JsonObject = { ...global };
		for (const [k, v] of Object.entries(project)) {
			out[k] = k in out ? deepMerge(out[k], v) : v;
		}
		return out;
	}
	return project === undefined ? global : project;
}

// ---- validation --------------------------------------------------------------

/** Pull the raw value at `path` out of a parsed settings file. */
function getPath(
	data: JsonObject | null,
	path: readonly string[],
): JsonValue | undefined {
	let cur: JsonValue | undefined = data;
	for (const seg of path) {
		if (!isPlainObject(cur)) return undefined;
		cur = cur[seg];
	}
	return cur;
}

/**
 * Validate a raw JSON value against a key's schema. Returns the coerced value
 * or null when the value is invalid for this key (the caller then falls
 * through to the other file / the default and records an issue).
 */
export function validateSettingValue(
	def: SettingKeyDef,
	raw: unknown,
): SettingValue | null {
	switch (def.type) {
		case "bool":
			return typeof raw === "boolean" ? raw : null;
		case "enum":
			return typeof raw === "string" && def.values?.includes(raw)
				? (raw as SettingValue)
				: null;
		case "number":
			return typeof raw === "number" &&
				Number.isInteger(raw) &&
				raw >= (def.min ?? 1)
				? raw
				: null;
		case "string":
			return typeof raw === "string" && raw.length > 0 ? raw : null;
		case "record":
			// A name → model map: every entry must be a non-empty string.
			if (!isPlainObject(raw)) return null;
			if (
				!Object.values(raw).every((v) => typeof v === "string" && v.length > 0)
			) {
				return null;
			}
			return raw as Record<string, string>;
	}
}

function describeSchema(def: SettingKeyDef): string {
	switch (def.type) {
		case "bool":
			return "must be true or false";
		case "enum":
			return `must be one of ${(def.values ?? []).join(" | ")}`;
		case "number":
			return `must be an integer >= ${def.min ?? 1}`;
		case "string":
			return "must be a non-empty string";
		case "record":
			return "must be an object of agent name → non-empty model id";
	}
}

// ---- load / resolve -----------------------------------------------------------

/** A problem found while reading a settings file, surfaced honestly to the user. */
export interface SettingsIssue {
	/** File the problem was found in. */
	path: string;
	/** Human-readable description. */
	problem: string;
}

export interface ResolvedSettings {
	/** Effective values after per-key precedence (project > global > default). */
	effective: HerdrSettings;
	/** Per-key source of the effective value. */
	sources: Record<SettingKey, SettingsSource>;
	/** Malformed JSON / unreadable file / invalid values that were skipped. */
	issues: SettingsIssue[];
}

interface RawFile {
	data: JsonObject | null;
	issues: SettingsIssue[];
}

function readSettingsFile(path: string): RawFile {
	if (!existsSync(path)) return { data: {}, issues: [] };
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (e) {
		return {
			data: null,
			issues: [
				{
					path,
					problem: `could not be read (${msg(e)})`,
				},
			],
		};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (e) {
		return {
			data: null,
			issues: [
				{
					path,
					problem: `malformed JSON (${msg(e)}) — values from this file are ignored; fix it by hand`,
				},
			],
		};
	}
	if (!isPlainObject(parsed)) {
		return {
			data: null,
			issues: [
				{ path, problem: "top-level value is not a JSON object — ignored" },
			],
		};
	}
	return { data: parsed, issues: [] };
}

/**
 * Load both settings files and resolve effective values with per-key source
 * tracking. Malformed or unreadable files contribute nothing (defaults and the
 * other file still apply) but are reported in `issues` — never silently.
 *
 * Scalar keys resolve first-valid-wins (project → global); the `models.agents`
 * record deep-merges per agent name across both files (project wins per
 * name), so a global pin and a project pin for different agents coexist.
 */
export function loadSettings(paths: SettingsPaths): ResolvedSettings {
	const globalFile = readSettingsFile(paths.globalPath);
	const projectFile = readSettingsFile(paths.projectPath);
	const issues = [...globalFile.issues, ...projectFile.issues];

	const effective: HerdrSettings = {
		...DEFAULT_SETTINGS,
		models: { default: DEFAULT_SETTINGS.models.default, agents: {} },
	};
	const sources = {} as Record<SettingKey, SettingsSource>;

	const candidates: [SettingsSource, JsonObject | null][] = [
		["project", projectFile.data],
		["global", globalFile.data],
	];

	for (const def of SETTING_KEYS) {
		if (def.type === "record") {
			// Merge per name across both files (project wins per name); the row's
			// source is the highest-precedence file that contributed entries.
			let merged: Record<string, string> | null = null;
			let source: SettingsSource = "default";
			for (const [src, data] of [...candidates].reverse()) {
				if (!data) continue;
				const raw = getPath(data, def.path);
				const validated = validateSettingValue(def, raw);
				if (validated === null) {
					if (raw !== undefined) {
						issues.push({
							path: src === "project" ? paths.projectPath : paths.globalPath,
							problem: `${def.key}: ${JSON.stringify(raw)} ignored (${describeSchema(def)})`,
						});
					}
					continue;
				}
				merged = { ...(merged ?? {}), ...(validated as Record<string, string>) };
				source = src;
			}
			if (merged !== null) {
				// SAFETY: the record branch only runs for models.agents, whose path
				// (["models","agents"]) addresses a plain-object field of HerdrSettings.
				setPath(effective as unknown as Record<string, unknown>, def.path, merged);
			}
			sources[def.key] = source;
			continue;
		}

		let value: SettingValue | null = null;
		let source: SettingsSource = "default";
		for (const [src, data] of candidates) {
			if (!data) continue;
			const raw = getPath(data, def.path);
			if (raw === undefined) continue;
			const validated = validateSettingValue(def, raw);
			if (validated === null) {
				issues.push({
					path: src === "project" ? paths.projectPath : paths.globalPath,
					problem: `${def.key}: ${JSON.stringify(raw)} ignored (${describeSchema(def)})`,
				});
				continue;
			}
			if (value === null) {
				value = validated;
				source = src;
			}
		}
		if (value !== null) {
			// SAFETY: validateSettingValue guarantees the value conforms to def's
			// schema (bool/enum/number/string), which is exactly the property type
			// TypeScript associates with def.path — the correlation just can't be
			// expressed through the loop variable.
			setPath(effective as unknown as Record<string, unknown>, def.path, value);
		}
		sources[def.key] = source;
	}

	return { effective, sources, issues };
}

// ---- write --------------------------------------------------------------------

/** Set `value` at `path` inside `target`, creating intermediate objects. */
function setPath(
	target: Record<string, unknown>,
	path: readonly string[],
	value: unknown,
): void {
	let cur = target;
	for (let i = 0; i < path.length - 1; i++) {
		const seg = path[i]!;
		if (!isPlainObject(cur[seg])) cur[seg] = {};
		cur = cur[seg] as Record<string, unknown>;
	}
	cur[path[path.length - 1]!] = value;
}

/** Read a parsed-file object for writing: {} when missing, null when unusable. */
function readForWrite(
	path: string,
):
	| { ok: true; existing: Record<string, unknown> }
	| { ok: false; error: string } {
	if (!existsSync(path)) return { ok: true, existing: {} };
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (e) {
		return {
			ok: false,
			error: `${path} is malformed JSON (${msg(e)}) — fix it by hand before editing settings here`,
		};
	}
	if (!isPlainObject(parsed)) {
		return {
			ok: false,
			error: `${path} is not a JSON object — fix it by hand before editing settings here`,
		};
	}
	return { ok: true, existing: parsed };
}

function persist(
	path: string,
	next: Record<string, unknown>,
): WriteSettingResult {
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify(next, null, "\t") + "\n", "utf8");
	} catch (e) {
		return {
			ok: false,
			error: `could not write ${path}: ${msg(e)}`,
		};
	}
	return { ok: true, path };
}

export type WriteSettingResult =
	| { ok: true; path: string }
	| { ok: false; error: string };

/**
 * Persist one key's value to a settings file (at the key's nested path),
 * preserving every other key in that file (including unknown ones). Creates
 * the file (and its directory) when missing. `null` DELETES the key — the
 * unset representation is absence, never a sentinel value. Refuses to touch a
 * file that exists but does not parse — a malformed file is never clobbered
 * by the menu.
 */
export function writeSetting(
	path: string,
	key: SettingKey,
	value: SettingValue | null,
): WriteSettingResult {
	const r = readForWrite(path);
	if (!r.ok) return r;
	const next = r.existing;
	if (value === null) unsetPath(next, settingKeyDef(key).path);
	else setPath(next, settingKeyDef(key).path, value);
	return persist(path, next);
}

/** Delete the value at `path`, pruning objects the deletion left empty. */
function unsetPath(
	target: Record<string, unknown>,
	path: readonly string[],
): void {
	const parent = objectAtPath(target, path.slice(0, -1));
	if (!parent) return;
	delete parent[path[path.length - 1]!];
	// prune now-empty ancestors along the path (never the root object itself)
	for (let i = path.length - 2; i >= 0; i--) {
		const ancestor = objectAtPath(target, path.slice(0, i + 1));
		if (ancestor && Object.keys(ancestor).length === 0) {
			const holder = objectAtPath(target, path.slice(0, i));
			if (holder) delete holder[path[i]!];
		}
	}
}

/** The object at `path`, or null when any segment is missing/non-object. */
function objectAtPath(
	target: Record<string, unknown>,
	path: readonly string[],
): Record<string, unknown> | null {
	let cur: unknown = target;
	for (const seg of path) {
		if (!isPlainObject(cur)) return null;
		cur = cur[seg];
	}
	return isPlainObject(cur) ? cur : null;
}

/**
 * Write ONE entry of a record key (`models.agents.<name>`): set
 * `models.agents[name] = model`, or delete the entry when `model` is null.
 * Preserves every other key and entry in the file. A removal on a file that
 * does not exist is a clean no-op — nothing is created just to delete from
 * it (the menu removes a pin from BOTH files, since the effective record is
 * their per-name merge).
 */
export function writeRecordEntry(
	path: string,
	key: SettingKey,
	entry: string,
	model: string | null,
): WriteSettingResult {
	if (model === null && !existsSync(path)) return { ok: true, path };
	const r = readForWrite(path);
	if (!r.ok) return r;
	const def = settingKeyDef(key);
	const containerPath = [...def.path];
	let container = objectAtPath(r.existing, containerPath);
	if (!isPlainObject(container)) {
		setPath(r.existing, containerPath, {});
		container = objectAtPath(r.existing, containerPath)!;
	}
	if (model === null) delete container[entry];
	else container[entry] = model;
	if (Object.keys(container).length === 0) unsetPath(r.existing, containerPath);
	return persist(path, r.existing);
}
