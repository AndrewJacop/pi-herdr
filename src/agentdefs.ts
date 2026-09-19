// Agent definitions: the schema `spawn_agent` consumes, the built-in trio,
// the session-ephemeral registry layer, and the `.md` file registry (v0.6
// issue 03).
//
// Decided by wayfinder ticket 01 — spawn_agent surface (specifier: `type` xor
// `agent`, exactly one; inline field set with enforce-or-error honesty) and
// ticket 02 — default agents (the tintinweb trio, content verbatim: full
// descriptions, read-only allowlists for Explore/Plan, general-purpose =
// all tools + empty prompt in append mode; NO model pins — every default
// inherits the user's configured pi model, pinning stays a registry override;
// no isDefault flag — ticket 01 killed silent defaults).
//
// Registry precedence is session > project > global > built-in. The `.md`
// layers live in `.pi/agents/` (project) and `<agent dir>/agents/` (global)
// — the SAME folders the coinstallable prior art reads (research §1, §11):
// unknown frontmatter keys are ignored on both sides, so the folder is
// shared, not fenced.

import type { Err, Result } from "./env.js";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

/** System-prompt application mode (shared with the `.md` frontmatter dialect). */
export type PromptMode = "replace" | "append";

/** How a child session begins (v0.6 field; consumed by the session-modes ticket). */
export type SessionMode = "standalone" | "lineage-only" | "fork";

/**
 * An agent definition — one `spawn_agent` blueprint.
 *
 * Field names are snake_case (tintinweb-compatible) plus the herdr key
 * (`kind`). Unknown keys in inline definitions are IGNORED (cross-dialect
 * no-ops, same rule the `.md` dialect applies to e.g. `thinking`/`max_turns`).
 */
export interface AgentDefinition {
	/** Registry identity (never a forced pane handle — spawn `name` is). */
	name: string;
	/** One-paragraph pitch; the tool description carries the built-ins'. */
	description?: string;
	/** Agent kind (pi/claude/…). Default: the settings default_kind. */
	kind?: string;
	/** Model pin; omitted = inherit the child CLI's configured model. */
	model?: string;
	/** System prompt; empty/omitted = leave the child CLI's default. */
	system_prompt?: string;
	/** How system_prompt applies (default "replace"). */
	prompt_mode?: PromptMode;
	/** Tool allowlist (pi `--tools`, claude `--tools`). */
	tools?: string[];
	/** Tool denylist (pi `--exclude-tools`, claude `--disallowedTools`). */
	exclude_tools?: string[];
	/** Skill paths to preload (pi-only; enforced at spawn). */
	skills?: string[];
	/** Raw agent-CLI flags appended after every computed flag (escape hatch). */
	agent_args?: string[];
	/** Thinking pin (routing level 2; consumed by the launch-plan ticket). */
	thinking?: string;
	/** Session mode (frontmatter `session-mode`; launch-plan ticket consumes). */
	session_mode?: SessionMode;
	/** Stance: auto-exit on settle (autonomous) — default when `interactive` is unset. */
	auto_exit?: boolean;
	/** Stance override: pane intentionally open, stall pings suppressed. */
	interactive?: boolean;
	/** Whether this agent may spawn children (frontmatter `spawning`). */
	spawning?: boolean;
	/** Working directory for spawns of this definition (frontmatter `cwd`). */
	cwd?: string;
}

/** A resolved registry lookup: the definition plus which layer served it. */
export interface ResolvedAgent {
	definition: AgentDefinition;
	layer: "session" | "project" | "global" | "built-in";
}

// ---- built-in trio (tintinweb content, verbatim) ----------------------------
// Extracted programmatically from tintinweb/pi-subagents master
// src/default-agents.ts so descriptions/system prompts stay byte-exact.
// Deviations, all decided by wayfinder ticket 02:
//   - Explore's model pin (anthropic/claude-haiku-4-5) is DROPPED — defaults
//     inherit the user's configured model; a wrong pin hard-fails the child.
//   - `isDefault` is dropped (ticket 01: no silent defaults).
//   - `extensions`/`skills` strategy booleans are dropped — a pane child runs
//     the user's own pi config; inheritance is the absence of a restriction.
// general-purpose keeps tintinweb's prompt_mode "append" (moot with an empty
// system_prompt, but verbatim is verbatim).

export const BUILT_IN_AGENTS: ReadonlyMap<string, AgentDefinition> = new Map([
	[
		"general-purpose",
		{
			name: "general-purpose",
			description:
				"General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks. When you are searching for a keyword or file and are not confident that you will find the right match in the first few tries use this agent to perform the search for you.",
			kind: "pi",
			system_prompt: "",
			prompt_mode: "append",
		},
	],
	[
		"Explore",
		{
			name: "Explore",
			description:
				'Fast read-only search agent for locating code. Use it to find files by pattern (eg. "src/components/**/*.tsx"), grep for symbols or keywords (eg. "API endpoints"), or answer "where is X defined / which files reference Y." Do NOT use it for code review, design-doc auditing, cross-file consistency checks, or open-ended analysis — it reads excerpts rather than whole files and will miss content past its read window. When calling, specify search breadth: "quick" for a single targeted lookup, "medium" for moderate exploration, or "very thorough" to search across multiple locations and naming conventions.',
			kind: "pi",
			tools: ["read", "bash", "grep", "find", "ls"],
			system_prompt:
				"# CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS\nYou are a file search specialist. You excel at thoroughly navigating and exploring codebases.\nYour role is EXCLUSIVELY to search and analyze existing code. You do NOT have access to file editing tools.\n\nYou are STRICTLY PROHIBITED from:\n- Creating new files\n- Modifying existing files\n- Deleting files\n- Moving or copying files\n- Creating temporary files anywhere, including /tmp\n- Using redirect operators (>, >>, |) or heredocs to write to files\n- Running ANY commands that change system state\n\nUse Bash ONLY for read-only operations: ls, git status, git log, git diff, find, cat, head, tail.\n\n# Tool Usage\n- Use the find tool for file pattern matching (NOT the bash find command)\n- Use the grep tool for content search (NOT bash grep/rg command)\n- Use the read tool for reading files (NOT bash cat/head/tail)\n- Use Bash ONLY for read-only operations\n- Make independent tool calls in parallel for efficiency\n- Adapt search approach based on thoroughness level specified\n\n# Output\n- Use absolute file paths in all references\n- Report findings as regular messages\n- Do not use emojis\n- Be thorough and precise",
			prompt_mode: "replace",
		},
	],
	[
		"Plan",
		{
			name: "Plan",
			description:
				"Software architect agent for designing implementation plans. Use this when you need to plan the implementation strategy for a task. Returns step-by-step plans, identifies critical files, and considers architectural trade-offs.",
			kind: "pi",
			tools: ["read", "bash", "grep", "find", "ls"],
			system_prompt:
				"# CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS\nYou are a software architect and planning specialist.\nYour role is EXCLUSIVELY to explore the codebase and design implementation plans.\nYou do NOT have access to file editing tools — attempting to edit files will fail.\n\nYou are STRICTLY PROHIBITED from:\n- Creating new files\n- Modifying existing files\n- Deleting files\n- Moving or copying files\n- Creating temporary files anywhere, including /tmp\n- Using redirect operators (>, >>, |) or heredocs to write to files\n- Running ANY commands that change system state\n\n# Planning Process\n1. Understand requirements\n2. Explore thoroughly (read files, find patterns, understand architecture)\n3. Design solution based on your assigned perspective\n4. Detail the plan with step-by-step implementation strategy\n\n# Requirements\n- Consider trade-offs and architectural decisions\n- Identify dependencies and sequencing\n- Anticipate potential challenges\n- Follow existing patterns where appropriate\n\n# Tool Usage\n- Use the find tool for file pattern matching (NOT the bash find command)\n- Use the grep tool for content search (NOT bash grep/rg command)\n- Use the read tool for reading files (NOT bash cat/head/tail)\n- Use Bash ONLY for read-only operations\n\n# Output Format\n- Use absolute file paths\n- Do not use emojis\n- End your response with:\n\n### Critical Files for Implementation\nList 3-5 files most critical for implementing this plan:\n- /absolute/path/to/file.ts - [Brief reason]",
			prompt_mode: "replace",
		},
	],
]);

// ---- session layer -----------------------------------------------------------
// Inline `agent:` definitions from accepted spawns this session. Ephemeral by
// definition: lost on restart, latest same-name write wins.

const sessionAgents = new Map<string, AgentDefinition>();

/** Register an inline definition in the session layer (accepted spawns only). */
export function registerSessionAgent(def: AgentDefinition): void {
	sessionAgents.set(def.name, def);
}

/** Session-layer names (latest registration order). */
export function sessionAgentNames(): string[] {
	return [...sessionAgents.keys()];
}

/** Drop every session-layer definition (tests). */
export function clearSessionAgents(): void {
	sessionAgents.clear();
}

/** Every addressable type: session names, then project files, global files, built-ins. */
export function listAgentTypes(dirs: AgentDirs = defaultAgentDirs()): {
	name: string;
	layer: ResolvedAgent["layer"];
}[] {
	return [
		...sessionAgentNames().map((name) => ({ name, layer: "session" as const })),
		...[...loadFileAgents(dirs).entries.entries()].map(([name, e]) => ({
			name,
			layer: e.layer,
		})),
		...[...BUILT_IN_AGENTS.keys()].map((name) => ({
			name,
			layer: "built-in" as const,
		})),
	];
}

/**
 * Resolve a `type` name against the registry: session > project > global >
 * built-in, first-hit-wins per name (project shadows global). File layers are
 * read at the moment they matter (same read-at-use rule as settings — a
 * freshly saved `.md` resolves without a reload). Malformed files never kill
 * the rest of the registry: they are skipped and reported in the unknown-type
 * error, the moment a lookup misses.
 */
export function resolveAgentType(
	type: string,
	dirs: AgentDirs = defaultAgentDirs(),
): Result<ResolvedAgent> {
	const sessionDef = sessionAgents.get(type);
	if (sessionDef)
		return { ok: true, data: { definition: sessionDef, layer: "session" } };
	const fileAgents = loadFileAgents(dirs);
	const fileEntry = fileAgents.entries.get(type);
	if (fileEntry)
		return {
			ok: true,
			data: { definition: fileEntry.definition, layer: fileEntry.layer },
		};
	const builtIn = BUILT_IN_AGENTS.get(type);
	if (builtIn)
		return { ok: true, data: { definition: builtIn, layer: "built-in" } };
	const issues = fileAgents.issues
		.map((i) => `${i.path} (${i.problem})`)
		.join("; ");
	return {
		ok: false,
		error: {
			code: "VALIDATION_ERROR",
			message:
				`Unknown agent type "${type}". Available: ${listAgentTypes(dirs)
					.map((t) => t.name)
					.join(", ")}.` +
				(issues
					? ` Skipped malformed agent file(s): ${issues} — fix or delete them.`
					: ""),
		},
	};
}

// ---- inline definition validation ---------------------------------------------

function err(message: string): Err {
	return { ok: false, error: { code: "VALIDATION_ERROR", message } };
}

function isStrArray(v: unknown): v is string[] {
	return (
		Array.isArray(v) && v.every((x) => typeof x === "string" && x.length > 0)
	);
}

/**
 * Validate an inline `agent: {...}` definition. Unknown keys are ignored
 * (cross-dialect no-ops); known keys must match their schema or the spawn
 * errors naming the field. `name` is required for registry registration but
 * optional overall — an anonymous inline agent simply isn't addressable by
 * `type` later (wayfinder ticket 01 decision 3).
 */
export function validateAgentDefinition(raw: unknown): Result<AgentDefinition> {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return err("`agent` must be an object (inline agent definition)");
	}
	const o = raw as Record<string, unknown>;
	const def: AgentDefinition = { name: "" };

	if (o.name !== undefined) {
		if (typeof o.name !== "string" || !o.name.trim())
			return err("agent.name must be a non-empty string");
		def.name = o.name;
	}
	if (o.description !== undefined) {
		if (typeof o.description !== "string" || !o.description.trim())
			return err("agent.description must be a non-empty string");
		def.description = o.description;
	}
	if (o.kind !== undefined) {
		if (typeof o.kind !== "string" || !o.kind.trim())
			return err("agent.kind must be a non-empty string");
		def.kind = o.kind;
	}
	if (o.model !== undefined) {
		if (typeof o.model !== "string" || !o.model.trim())
			return err("agent.model must be a non-empty string");
		def.model = o.model;
	}
	if (o.system_prompt !== undefined) {
		if (typeof o.system_prompt !== "string")
			return err("agent.system_prompt must be a string");
		def.system_prompt = o.system_prompt;
	}
	if (o.prompt_mode !== undefined) {
		if (o.prompt_mode !== "replace" && o.prompt_mode !== "append")
			return err('agent.prompt_mode must be "replace" or "append"');
		def.prompt_mode = o.prompt_mode;
	}
	if (o.tools !== undefined) {
		if (!isStrArray(o.tools))
			return err("agent.tools must be an array of tool names");
		def.tools = o.tools;
	}
	if (o.exclude_tools !== undefined) {
		if (!isStrArray(o.exclude_tools))
			return err("agent.exclude_tools must be an array of tool names");
		def.exclude_tools = o.exclude_tools;
	}
	if (o.skills !== undefined) {
		if (!isStrArray(o.skills))
			return err("agent.skills must be an array of skill paths");
		def.skills = o.skills;
	}
	if (o.agent_args !== undefined) {
		if (!isStrArray(o.agent_args))
			return err("agent.agent_args must be an array of CLI flag strings");
		def.agent_args = o.agent_args;
	}
	if (o.thinking !== undefined) {
		if (typeof o.thinking !== "string" || !o.thinking.trim())
			return err("agent.thinking must be a non-empty string");
		def.thinking = o.thinking;
	}
	if (o.session_mode !== undefined) {
		if (
			o.session_mode !== "standalone" &&
			o.session_mode !== "lineage-only" &&
			o.session_mode !== "fork"
		)
			return err(
				'agent.session_mode must be "standalone", "lineage-only", or "fork"',
			);
		def.session_mode = o.session_mode;
	}
	for (const b of ["auto_exit", "interactive", "spawning"] as const) {
		if (o[b] !== undefined) {
			if (typeof o[b] !== "boolean")
				return err(`agent.${b} must be true or false`);
			def[b] = o[b];
		}
	}
	if (o.cwd !== undefined) {
		if (typeof o.cwd !== "string" || !o.cwd.trim())
			return err("agent.cwd must be a non-empty string");
		def.cwd = o.cwd;
	}
	return { ok: true, data: def };
}

/**
 * Resolve the spawn specifier: `type` xor `agent`, exactly one (wayfinder
 * ticket 01 decision 1 — no silent default agent). Returns the definition and
 * whether it came from the registry or was inline.
 */
export function resolveSpecifier(
	spec: {
		type?: unknown;
		agent?: unknown;
	},
	dirs: AgentDirs = defaultAgentDirs(),
): Result<{ definition: AgentDefinition; inline: boolean }> {
	const hasType = spec.type !== undefined;
	const hasAgent = spec.agent !== undefined;
	if (hasType && hasAgent) {
		return err(
			"Pass exactly one of `type` (registry name) or `agent` (inline definition) — not both.",
		);
	}
	if (!hasType && !hasAgent) {
		return err(
			'Pass one of `type` (registry name, e.g. "Explore") or `agent` (inline definition).',
		);
	}
	if (hasAgent) {
		const v = validateAgentDefinition(spec.agent);
		if (!v.ok) return v;
		return { ok: true, data: { definition: v.data, inline: true } };
	}
	if (typeof spec.type !== "string" || !spec.type.trim()) {
		return err("`type` must be a non-empty string");
	}
	const r = resolveAgentType(spec.type, dirs);
	if (!r.ok) return r;
	return { ok: true, data: { definition: r.data.definition, inline: false } };
}

// ---- the `.md` frontmatter dialect (v0.6 issue 03) ----------------------------
//
// A file is `---\n<frontmatter>\n---\n\n<body>`: frontmatter carries the
// identity/routing/stance fields, the body IS the system prompt. The dialect
// is deliberately shared with the coinstallable prior art (research §1, §11):
// keys we don't know are ignored, and our keys are ignored by theirs. Key
// spellings follow the issue's mixed dialect — kebab-case for the keys whose
// shape we share with the prior art (`session-mode`, `auto-exit`, `deny-tools`,
// `args`), snake_case for ours (`prompt_mode`). List values accept either a
// JSON array (what the writer emits; JSON is valid YAML flow syntax) or a
// plain comma list (what the prior art writes). Scalars may be bare or
// quoted (double-quoted values parse as JSON strings, so any character
// round-trips).

/** The frontmatter keys this dialect knows, mapped to definition fields. */
const FRONTMATTER_KEYS: Readonly<Record<string, keyof AgentDefinition>> = {
	name: "name",
	description: "description",
	kind: "kind",
	model: "model",
	thinking: "thinking",
	"session-mode": "session_mode",
	"auto-exit": "auto_exit",
	interactive: "interactive",
	spawning: "spawning",
	"deny-tools": "exclude_tools",
	args: "agent_args",
	cwd: "cwd",
	prompt_mode: "prompt_mode",
	tools: "tools",
	skills: "skills",
};

/** Reverse map: definition field → canonical frontmatter key. */
const FIELD_TO_KEY: Readonly<Partial<Record<keyof AgentDefinition, string>>> =
	Object.fromEntries(Object.entries(FRONTMATTER_KEYS).map(([k, f]) => [f, k]));

/** Written field order: identity, routing, stance, tooling, io. */
const FIELD_ORDER: readonly (keyof AgentDefinition)[] = [
	"name",
	"description",
	"kind",
	"model",
	"thinking",
	"session_mode",
	"auto_exit",
	"interactive",
	"spawning",
	"tools",
	"exclude_tools",
	"skills",
	"agent_args",
	"cwd",
	"prompt_mode",
];

const FRONTMATTER_BLOCK = /^---\r?\n([\s\S]*?)\r?\n?---(?:\r?\n|$)/;

/** Read one double- or single-quoted (or bare) scalar. */
function unquoteScalar(value: string, key: string): Result<string> {
	const t = value.trim();
	if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
		try {
			const parsed: unknown = JSON.parse(t);
			if (typeof parsed === "string") return { ok: true, data: parsed };
		} catch {
			/* fall through to the error */
		}
		return err(`frontmatter key "${key}": malformed double-quoted value (${t})`);
	}
	if (t.length >= 2 && t.startsWith("'") && t.endsWith("'"))
		return { ok: true, data: t.slice(1, -1) };
	return { ok: true, data: t };
}

/** Read a list value: JSON array (writer form) or plain comma list (prior art). */
function parseListValue(value: string, key: string): Result<string[]> {
	const t = value.trim();
	if (t.startsWith("[")) {
		try {
			const parsed: unknown = JSON.parse(t);
			if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string"))
				return { ok: true, data: parsed as string[] };
		} catch {
			/* fall through to the error */
		}
		return err(`frontmatter key "${key}": malformed array value (${t})`);
	}
	return {
		ok: true,
		data: t
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean),
	};
}

/**
 * Parse one `.md` agent file. Frontmatter lines become the (coerced) raw
 * object `validateAgentDefinition` checks — one definition contract for
 * inline and file sources. Unknown keys are ignored (shared folder);
 * indented/colon-less lines are ignored as foreign YAML (nesting, block
 * lists) rather than fatal. The body, when non-empty, becomes system_prompt.
 */
export function parseAgentMarkdown(
	content: string,
	fallbackName: string,
): Result<AgentDefinition> {
	if (content.charCodeAt(0) === 0xfeff) content = content.slice(1); // BOM
	const m = content.match(FRONTMATTER_BLOCK);
	if (!m)
		return err(
			"no YAML frontmatter block (`---` … `---`) at the top of the file",
		);
	const body = content.replace(FRONTMATTER_BLOCK, "").trim();
	const raw: Record<string, unknown> = {};
	for (const line of m[1].split(/\r?\n/)) {
		if (!line.trim() || /^\s/.test(line) || line.trim().startsWith("#")) continue;
		const idx = line.indexOf(":");
		if (idx === -1) continue;
		const key = line.slice(0, idx).trim();
		const value = line.slice(idx + 1);
		const field = FRONTMATTER_KEYS[key];
		if (!field) continue; // unknown key — ignored (shared folder)
		if (
			field === "auto_exit" ||
			field === "interactive" ||
			field === "spawning"
		) {
			// true/false coerce to booleans; anything else passes through for the
			// validator to reject naming the field.
			const t = value.trim();
			if (t === "true" || t === "false") raw[field] = t === "true";
			else if (t !== "") raw[field] = t;
			continue;
		}
		if (
			field === "tools" ||
			field === "skills" ||
			field === "exclude_tools" ||
			field === "agent_args"
		) {
			if (value.trim() === "") continue; // empty list ≡ absent
			const list = parseListValue(value, key);
			if (!list.ok) return list;
			raw[field] = list.data;
			continue;
		}
		if (value.trim() === "") continue; // empty scalar ≡ absent (name falls back)
		const scalar = unquoteScalar(value, key);
		if (!scalar.ok) return scalar;
		raw[field] = scalar.data;
	}
	if (raw.name === undefined) raw.name = fallbackName;
	const v = validateAgentDefinition(raw);
	if (!v.ok) return v;
	if (body) v.data.system_prompt = body;
	return v;
}

/** How the writer quotes a scalar (reader inverse: JSON strings round-trip). */
function quoteScalar(value: string): string {
	if (value === "" || /^[\s"'[{]/.test(value) || /\s$/.test(value))
		return JSON.stringify(value);
	return value;
}

/**
 * Serialize a definition to the `.md` dialect: every set field in canonical
 * order, lists as JSON arrays, the system prompt as the body. Refuses the
 * one value the line-based dialect cannot carry: a newline inside a
 * frontmatter scalar (the system prompt belongs in the body, not here).
 */
export function formatAgentMarkdown(def: AgentDefinition): Result<string> {
	const lines: string[] = [];
	for (const field of FIELD_ORDER) {
		const value = def[field];
		if (value === undefined) continue;
		const key = FIELD_TO_KEY[field];
		if (!key) continue;
		if (typeof value === "boolean") {
			lines.push(`${key}: ${value}`);
		} else if (Array.isArray(value)) {
			if (value.length) lines.push(`${key}: ${JSON.stringify(value)}`);
		} else {
			if (/[\r\n]/.test(value))
				return err(
					`agent.${field} cannot be saved: frontmatter values must be single-line (move prose to the system-prompt body)`,
				);
			lines.push(`${key}: ${quoteScalar(value)}`);
		}
	}
	const body = def.system_prompt ?? "";
	return { ok: true, data: `---\n${lines.join("\n")}\n---\n\n${body}\n` };
}

// ---- file layers ---------------------------------------------------------------

/** The two `.md` registry folders (project shadows global). */
export interface AgentDirs {
	project: string;
	global: string;
}

/** Default folders for a session cwd: `<cwd>/.pi/agents` and `<agent dir>/agents`. */
export function defaultAgentDirs(cwd: string = process.cwd()): AgentDirs {
	return {
		project: join(cwd, CONFIG_DIR_NAME, "agents"),
		global: join(getAgentDir(), "agents"),
	};
}

/** A problem with one agent file, reported without killing the rest. */
export interface AgentFileIssue {
	path: string;
	problem: string;
}

/** One loaded file-backed definition. */
export interface FileAgentEntry {
	definition: AgentDefinition;
	layer: "project" | "global";
	path: string;
}

export interface FileAgents {
	/** name → entry, first-hit-wins per name (project scanned before global). */
	entries: ReadonlyMap<string, FileAgentEntry>;
	/** Malformed/unreadable files: skipped, never fatal to the rest. */
	issues: readonly AgentFileIssue[];
}

function errMsg(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/**
 * Load every `.md` agent file from both registry dirs. Project is scanned
 * before global and first-hit-wins per name, so a project file shadows a
 * same-name global one. A file that is unreadable, frontmatter-less, or fails
 * validation becomes an issue and is skipped — the rest of the registry
 * still loads.
 */
export function loadFileAgents(dirs: AgentDirs): FileAgents {
	const entries = new Map<string, FileAgentEntry>();
	const issues: AgentFileIssue[] = [];
	for (const layer of ["project", "global"] as const) {
		const dir = dirs[layer];
		let files: string[];
		try {
			if (!existsSync(dir)) continue;
			// sorted for deterministic first-hit within a dir (two files claiming
			// one name in the SAME dir is a user error; the first wins, stably)
			files = readdirSync(dir)
				.filter((f) => f.endsWith(".md"))
				.sort();
		} catch (e) {
			issues.push({
				path: dir,
				problem: `could not list directory (${errMsg(e)})`,
			});
			continue;
		}
		for (const file of files) {
			const path = join(dir, file);
			let content: string;
			try {
				content = readFileSync(path, "utf8");
			} catch (e) {
				issues.push({ path, problem: `could not be read (${errMsg(e)})` });
				continue;
			}
			const parsed = parseAgentMarkdown(content, file.replace(/\.md$/, ""));
			if (!parsed.ok) {
				issues.push({ path, problem: parsed.error.message });
				continue;
			}
			if (!entries.has(parsed.data.name))
				entries.set(parsed.data.name, { definition: parsed.data, layer, path });
		}
	}
	return { entries, issues };
}

// ---- save_agent ------------------------------------------------------------------

export interface SaveAgentParams {
	/** Registry name of an existing definition (any layer) to persist. */
	type?: unknown;
	/** Inline definition to persist. */
	agent?: unknown;
	/** Which registry folder to write (default: project — local + reversible). */
	target?: "project" | "global";
	/** Replace an existing file at the target path (default: refuse). */
	overwrite?: boolean;
}

export type SaveAgentResult = Result<{
	name: string;
	path: string;
	target: "project" | "global";
}>;

/** File name for a registry name (non-path characters collapse to `-`). */
function fileSlug(name: string): string {
	return (
		name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "agent"
	);
}

/**
 * Persist a definition as a `.md` file in the chosen registry folder (v0.6
 * issue 03 — ungated by decision: low risk, reversible by deleting the file).
 * The written file resolves immediately (read-at-use registry) in this
 * session and in every fresh one. Refuses to clobber an existing file unless
 * `overwrite` is set — a hand-authored file is the user's content.
 */
export function saveAgent(
	params: SaveAgentParams,
	dirs: AgentDirs = defaultAgentDirs(),
): SaveAgentResult {
	const spec = resolveSpecifier(
		{ type: params.type, agent: params.agent },
		dirs,
	);
	if (!spec.ok) return spec;
	const def = spec.data.definition;
	if (!def.name)
		return err("a saved agent needs a `name` to be addressable by `type` later");
	const target = params.target ?? "project";
	const text = formatAgentMarkdown(def);
	if (!text.ok) return text;
	const dir = target === "global" ? dirs.global : dirs.project;
	const path = join(dir, `${fileSlug(def.name)}.md`);
	if (!params.overwrite && existsSync(path))
		return err(
			`${path} already exists — pass overwrite: true to replace it, or delete the file first`,
		);
	try {
		mkdirSync(dir, { recursive: true });
		writeFileSync(path, text.data, "utf8");
	} catch (e) {
		return err(`could not write ${path}: ${errMsg(e)}`);
	}
	return { ok: true, data: { name: def.name, path, target } };
}
