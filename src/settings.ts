// Settings layer: the knobs every later ticket consults.
//
// Effective settings are the deep merge of the global file (~/.pi/agent/
// herdr.json) and the project file (<cwd>/.pi/herdr.json), with the project
// file winning per key. Every resolved value tracks its source
// (project | global | default) so the /herdr menu can annotate rows.
//
// Hot-reload model: six keys (default_kind, max_parallel_agents,
// max_spawn_depth, agents_kill_switch, allow_save_agent, notifications) are
// read at the moment they matter (spawn / save / notify). `surface` is read
// once at init and is restart-required (/reload).

import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Which file supplied a setting's effective value. */
export type SettingsSource = "project" | "global" | "default";

export interface HerdrSettings {
	surface: "agents" | "full";
	default_kind: string;
	max_parallel_agents: number;
	agents_kill_switch: boolean;
	max_spawn_depth: number;
	allow_save_agent: boolean;
	notifications: "none" | "quiet" | "normal";
}

export type SettingKey = keyof HerdrSettings;
export type SettingValue = HerdrSettings[SettingKey];

export type SettingType = "bool" | "enum" | "number" | "string";

export interface SettingKeyDef {
	key: SettingKey;
	group: "safety" | "behavior";
	type: SettingType;
	default: SettingValue;
	/** enum choices (type: "enum"). */
	values?: readonly string[];
	/** inclusive floor (type: "number"). */
	min?: number;
	/** true when the running session caches the value; the menu marks it. */
	restartRequired?: boolean;
	description: string;
}

/**
 * The seven keys, in menu order: safety gates first, then behavior.
 * (Decided by wayfinder ticket 03 — settings menu.)
 */
export const SETTING_KEYS: readonly SettingKeyDef[] = [
	{
		key: "agents_kill_switch",
		group: "safety",
		type: "bool",
		default: false,
		description:
			"Refuse new agent spawns. A gate only — never terminates running agents.",
	},
	{
		key: "allow_save_agent",
		group: "safety",
		type: "bool",
		default: false,
		description:
			"Allow the save_agent tool to write agent definitions to the registry.",
	},
	{
		key: "surface",
		group: "behavior",
		type: "enum",
		values: ["agents", "full"],
		default: "agents",
		restartRequired: true,
		description:
			"Tool set the model sees: 'agents' (v0.5 agent-experience tools) or 'full' (the complete fleet tool set).",
	},
	{
		key: "default_kind",
		group: "behavior",
		type: "string",
		default: "pi",
		description:
			"Agent kind spawned when none is given. Validated against the live `herdr agent` kind list.",
	},
	{
		key: "max_parallel_agents",
		group: "behavior",
		type: "number",
		min: 1,
		default: 3,
		description:
			"Concurrency cap for running agents; spawns beyond it are queued until a slot frees.",
	},
	{
		key: "max_spawn_depth",
		group: "behavior",
		type: "number",
		min: 1,
		default: 2,
		description:
			"Maximum spawn depth; the guard against runaway recursive fleets.",
	},
	{
		key: "notifications",
		group: "behavior",
		type: "enum",
		values: ["none", "quiet", "normal"],
		default: "normal",
		description: "Verbosity of agent-completion notifications.",
	},
];

export const DEFAULT_SETTINGS: Readonly<HerdrSettings> = Object.freeze({
	surface: "agents",
	default_kind: "pi",
	max_parallel_agents: 3,
	agents_kill_switch: false,
	max_spawn_depth: 2,
	allow_save_agent: false,
	notifications: "normal",
});

// Tests assert every SETTING_KEYS default matches DEFAULT_SETTINGS, so the
// two can't drift.

export function settingKeyDef(key: SettingKey): SettingKeyDef {
	const def = SETTING_KEYS.find((d) => d.key === key);
	if (!def) throw new Error(`unknown setting key: ${key}`);
	return def;
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
					problem: `could not be read (${e instanceof Error ? e.message : String(e)})`,
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
					problem: `malformed JSON (${e instanceof Error ? e.message : String(e)}) — values from this file are ignored; fix it by hand`,
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
 */
export function loadSettings(paths: SettingsPaths): ResolvedSettings {
	const globalFile = readSettingsFile(paths.globalPath);
	const projectFile = readSettingsFile(paths.projectPath);
	const issues = [...globalFile.issues, ...projectFile.issues];

	const effective: HerdrSettings = { ...DEFAULT_SETTINGS };
	const sources = {} as Record<SettingKey, SettingsSource>;

	for (const def of SETTING_KEYS) {
		const candidates: [SettingsSource, JsonObject | null][] = [
			["project", projectFile.data],
			["global", globalFile.data],
		];
		let value: SettingValue | null = null;
		let source: SettingsSource = "default";
		for (const [src, data] of candidates) {
			if (!data || !(def.key in data)) continue;
			const validated = validateSettingValue(def, data[def.key]);
			if (validated === null) {
				issues.push({
					path: src === "project" ? paths.projectPath : paths.globalPath,
					problem: `${def.key}: ${JSON.stringify(data[def.key])} ignored (${describeSchema(def)})`,
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
			// TypeScript associates with def.key — the correlation just can't be
			// expressed through the loop variable.
			(effective as Record<SettingKey, SettingValue>)[def.key] = value;
		}
		sources[def.key] = source;
	}

	return { effective, sources, issues };
}

// ---- write --------------------------------------------------------------------

export type WriteSettingResult =
	| { ok: true; path: string }
	| { ok: false; error: string };

/**
 * Persist one key's value to a settings file, preserving every other key in
 * that file (including unknown ones). Creates the file (and its directory)
 * when missing. Refuses to touch a file that exists but does not parse — a
 * malformed file is never clobbered by the menu.
 */
export function writeSetting(
	path: string,
	key: SettingKey,
	value: SettingValue,
): WriteSettingResult {
	let existing: Record<string, unknown> = {};
	if (existsSync(path)) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(path, "utf8"));
		} catch (e) {
			return {
				ok: false,
				error: `${path} is malformed JSON (${e instanceof Error ? e.message : String(e)}) — fix it by hand before editing settings here`,
			};
		}
		if (!isPlainObject(parsed)) {
			return {
				ok: false,
				error: `${path} is not a JSON object — fix it by hand before editing settings here`,
			};
		}
		existing = parsed;
	}
	const next = { ...existing, [key]: value };
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify(next, null, "\t") + "\n", "utf8");
	} catch (e) {
		return {
			ok: false,
			error: `could not write ${path}: ${e instanceof Error ? e.message : String(e)}`,
		};
	}
	return { ok: true, path };
}
