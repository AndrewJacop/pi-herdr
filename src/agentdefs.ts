// Agent definitions: the schema `spawn_agent` consumes, the built-in trio,
// and the session-ephemeral registry layer.
//
// Decided by wayfinder ticket 01 — spawn_agent surface (specifier: `type` xor
// `agent`, exactly one; inline field set with enforce-or-error honesty) and
// ticket 02 — default agents (the tintinweb trio, content verbatim: full
// descriptions, read-only allowlists for Explore/Plan, general-purpose =
// all tools + empty prompt in append mode; NO model pins — every default
// inherits the user's configured pi model, pinning stays a registry override;
// no isDefault flag — ticket 01 killed silent defaults).
//
// Registry precedence is session > project > global > built-in. This module
// owns the session + built-in layers; the file-backed project/global layers
// arrive with the `.md` registry ticket and slot into resolveAgentType.

import type { Err, Result } from "./env.js";

/** System-prompt application mode (shared with the `.md` frontmatter dialect). */
export type PromptMode = "replace" | "append";

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
}

/** A resolved registry lookup: the definition plus which layer served it. */
export interface ResolvedAgent {
	definition: AgentDefinition;
	layer: "session" | "built-in";
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

/** Every addressable type: session names first, then the built-in trio. */
export function listAgentTypes(): {
	name: string;
	layer: ResolvedAgent["layer"];
}[] {
	return [
		...sessionAgentNames().map((name) => ({ name, layer: "session" as const })),
		...[...BUILT_IN_AGENTS.keys()].map((name) => ({
			name,
			layer: "built-in" as const,
		})),
	];
}

/**
 * Resolve a `type` name against the registry. Session wins over built-in;
// project/global file layers slot in here when the `.md` registry lands.
 * Unknown names error listing every available type.
 */
export function resolveAgentType(type: string): Result<ResolvedAgent> {
	const sessionDef = sessionAgents.get(type);
	if (sessionDef)
		return { ok: true, data: { definition: sessionDef, layer: "session" } };
	const builtIn = BUILT_IN_AGENTS.get(type);
	if (builtIn)
		return { ok: true, data: { definition: builtIn, layer: "built-in" } };
	return {
		ok: false,
		error: {
			code: "VALIDATION_ERROR",
			message: `Unknown agent type "${type}". Available: ${listAgentTypes()
				.map((t) => t.name)
				.join(", ")}.`,
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
	return { ok: true, data: def };
}

/**
 * Resolve the spawn specifier: `type` xor `agent`, exactly one (wayfinder
 * ticket 01 decision 1 — no silent default agent). Returns the definition and
 * whether it came from the registry or was inline.
 */
export function resolveSpecifier(spec: {
	type?: unknown;
	agent?: unknown;
}): Result<{ definition: AgentDefinition; inline: boolean }> {
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
	const r = resolveAgentType(spec.type);
	if (!r.ok) return r;
	return { ok: true, data: { definition: r.data.definition, inline: false } };
}
