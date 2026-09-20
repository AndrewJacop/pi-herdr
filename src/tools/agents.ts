// The v0.5 agent surface — `herdr_spawn_agent`.
//
// One call: resolve the agent (registry `type` or inline `agent`), pass the
// gates, spawn a pane, submit the prompt, return {name, paneId, status}.
// The engine and every decision live in src/spawn.ts + src/agentdefs.ts;
// this file is the thin pi registration (name, description, schema, format).
//
// Tool naming keeps the repo's herdr_ prefix (wayfinder ticket 06's naming
// note: the charter's unprefixed names were shorthand).

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { spawnAgent } from "../spawn.js";
import { saveAgent } from "../agentdefs.js";
import type { ToolReturn } from "../env.js";
import { BUILT_IN_AGENTS } from "../agentdefs.js";

function fail(message: string, code: string, details?: unknown): ToolReturn {
	return {
		content: [{ type: "text", text: `Error (${code}): ${message}` }],
		details: { error: { code, message, details } },
		isError: true,
	};
}

/** The trio's full descriptions, verbatim, for the tool description. */
function builtInTypeLines(): string {
	return [...BUILT_IN_AGENTS.values()]
		.map((d) => `- ${d.name} (${d.kind}) — ${d.description}`)
		.join("\n");
}

const DESCRIPTION =
	"Spawn a background AI agent in a herdr pane, submit the task prompt, and return " +
	"{name, paneId, status}. Address the agent by `name` afterwards. " +
	"Specify the agent EITHER by `type` (registry) or an inline `agent` definition — exactly one. " +
	`Built-in types:\n${builtInTypeLines()}\n` +
	"The registry also serves `.md` definitions from `.pi/agents/` (project) and the global " +
	"agents dir — project shadows global, session inline definitions shadow both. " +
	"Inline definitions from earlier spawns this session are addressable by `type` too. " +
	"Inline `agent` fields: name, description, kind, model, thinking, system_prompt, prompt_mode " +
	"(replace|append, default replace), tools, exclude_tools, skills (pi-only), agent_args " +
	"(raw CLI flags), session_mode (standalone|lineage-only|fork), auto_exit, interactive, " +
	"spawning, cwd. Honesty rule: a field the chosen kind cannot enforce refuses the spawn " +
	"naming the field — use agent_args or another kind. `kind` (default: settings default_kind, " +
	"'pi') is an unopinionated passthrough onto herdr's native `agent start --kind` axis: a non-pi " +
	"child is text in a pane with a TUI-detected lifecycle, nothing else. " +
	"`kind`/`model`/`thinking` override the definition's; unset ones resolve down the routing chain — " +
	"spawn param > frontmatter > models.agents.<name> (settings) > models.default (settings) > this session's model — " +
	"exact authenticated provider/model-id only, no fuzzy resolution; a bad value refuses the spawn naming the routing level " +
	"that supplied it. Thinking never inherits from the parent (the child keeps its own default). Every pi child runs on a parent-owned session file in " +
	"pi's default sessions dir (`--session`, seeded before launch), loads the injected child extension " +
	"(`agent_done`, identity strip, typed completion sidecars), and is named `herdr/<name>` in /resume — " +
	"the session file is the source of truth for its result; sessions are never deleted. Prompts over " +
	"2000 chars are written to `<session>.task.md` and delivered as a one-line reference. Raw CLI flags " +
	"ride `agent_args` (spawn level, appended after the definition's `args:` — last-wins). Stance (v0.6): " +
	"autonomous by default (auto-exit on settle; pane closes, session retained), `interactive: true` or " +
	"`auto_exit: false` keeps the pane open. Background by default; `wait: true` blocks until " +
	"done-or-blocked, `wait: <ms>` returns the current state on expiry. At max_parallel_agents the " +
	"spawn is accepted queued (no pane until a slot frees; wait waits through the queue). " +
	"`isolated: true` runs the agent in a fresh auto-created herdr-side git worktree " +
	"(worktree stays after the agent — remove it yourself with `herdr worktree remove` or git). " +
	"Gates, checked in order before any side effect: kill-switch, spawn depth, parallel cap. " +
	"No layout parameters — panes split right in the current tab.";

/** The inline `agent: {…}` definition schema — shared by spawn_agent and save_agent. */
const AGENT_DEF_SCHEMA = Type.Object({
	name: Type.Optional(
		Type.String({
			description:
				"Definition name; registers session-ephemerally (addressable by type later).",
		}),
	),
	description: Type.Optional(Type.String()),
	kind: Type.Optional(
		Type.String({ description: "Agent kind (default: settings default_kind)." }),
	),
	model: Type.Optional(
		Type.String({ description: "Model pin (omit to inherit)." }),
	),
	thinking: Type.Optional(
		Type.String({ description: "Thinking-level pin (omit to inherit)." }),
	),
	system_prompt: Type.Optional(
		Type.String({ description: "System prompt; empty = child CLI default." }),
	),
	prompt_mode: Type.Optional(
		StringEnum(["replace", "append"] as const, {
			description: "How system_prompt applies (default replace).",
		}),
	),
	tools: Type.Optional(
		Type.Array(Type.String(), {
			description: "Tool allowlist, e.g. [read, bash, grep, find, ls].",
		}),
	),
	exclude_tools: Type.Optional(
		Type.Array(Type.String(), { description: "Tool denylist." }),
	),
	skills: Type.Optional(
		Type.Array(Type.String(), {
			description: "Skill paths to preload (pi-only; other kinds refuse).",
		}),
	),
	agent_args: Type.Optional(
		Type.Array(Type.String(), {
			description: "Raw agent-CLI flags appended last (escape hatch).",
		}),
	),
	session_mode: Type.Optional(
		StringEnum(["standalone", "lineage-only", "fork"] as const, {
			description: "How the child session begins (default standalone).",
		}),
	),
	auto_exit: Type.Optional(
		Type.Boolean({
			description:
				"Stance: auto-exit on settle — autonomous (default when interactive unset).",
		}),
	),
	interactive: Type.Optional(
		Type.Boolean({
			description:
				"Stance override: pane intentionally open, stall pings suppressed.",
		}),
	),
	spawning: Type.Optional(
		Type.Boolean({ description: "Whether this agent may spawn children." }),
	),
	cwd: Type.Optional(
		Type.String({
			description: "Working directory for spawns of this definition.",
		}),
	),
});

export function registerAgents(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "herdr_spawn_agent",
		label: "Spawn herdr agent",
		description: DESCRIPTION,
		promptSnippet: "Spawn a background herdr agent pane running a task prompt",
		promptGuidelines: [
			"Use herdr_spawn_agent to fan out background work: it spawns the pane, submits the prompt, and returns a handle you address later.",
			"Prefer the built-in read-only types (Explore, Plan) for search/planning; general-purpose for multi-step work.",
		],
		parameters: Type.Object({
			prompt: Type.String({
				description: "Task for the agent (its first prompt).",
			}),
			type: Type.Optional(
				Type.String({
					description:
						'Registry agent type, e.g. "general-purpose", "Explore", "Plan", or a session inline definition name. Exactly one of type/agent.',
				}),
			),
			agent: Type.Optional(AGENT_DEF_SCHEMA),
			name: Type.Optional(
				Type.String({
					description:
						"Pane handle for addressing the agent later (fallback chain when omitted/taken: definition name → agent-<timestamp>, uniquified).",
				}),
			),
			kind: Type.Optional(
				Type.String({ description: "Kind override (merges over the definition)." }),
			),
			model: Type.Optional(
				Type.String({
					description: "Model override (merges over the definition).",
				}),
			),
			thinking: Type.Optional(
				Type.String({
					description:
						"Thinking-level override (routing level 1): off|minimal|low|medium|high|xhigh|max. Pi children only — other kinds refuse an explicit pin.",
				}),
			),
			agent_args: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Raw agent-CLI flags appended after the definition's args: — later duplicates win (last-wins override).",
				}),
			),
			cwd: Type.Optional(
				Type.String({
					description: "Working directory (mutually exclusive with isolated).",
				}),
			),
			isolated: Type.Optional(
				Type.Boolean({
					description: "Spawn into a fresh auto-created herdr-side git worktree.",
				}),
			),
			wait: Type.Optional(
				Type.Union([Type.Boolean(), Type.Integer()], {
					description:
						"true = block until done-or-blocked; ms = return current state on expiry; omit = background (default).",
				}),
			),
		}),
		async execute(
			_id,
			p,
			signal,
			_onUpdate,
			ctx: ExtensionContext | undefined,
		) {
			const r = await spawnAgent(
				{
					prompt: p.prompt,
					type: p.type,
					agent: p.agent,
					name: p.name,
					kind: p.kind,
					model: p.model,
					thinking: p.thinking,
					agent_args: p.agent_args,
					cwd: p.cwd,
					isolated: p.isolated,
					wait: p.wait,
				},
				{
					signal,
					// Routing level 5 (parent session's model) + exact-model
					// validation come from THIS session's pi context.
					parent:
						ctx?.model
							? { model: { provider: ctx.model.provider, id: ctx.model.id } }
							: undefined,
					registry: ctx?.modelRegistry,
				},
			);
			if (!r.ok) return fail(r.error.message, r.error.code, r.error.details);
			const d = r.data;
			const where = d.paneId ? `pane ${d.paneId}` : "no pane yet (queued)";
			const type = d.type ? ` (type ${d.type})` : "";
			const session = d.sessionPath ? ` Session file: ${d.sessionPath}.` : "";
			const stance = ` Stance: ${d.stance}.`;
			const worktree = d.worktreePath
				? ` Isolated worktree: ${d.worktreePath}`
				: "";
			const text = d.queued
				? `Spawn accepted as QUEUED: "${d.name}"${type} — fleet is at max_parallel_agents; the pane starts when a slot frees.${stance}`
				: `Spawned ${d.kind} agent "${d.name}"${type} in ${where}; status: ${d.status}.${stance}${session}${worktree}`;
			return {
				content: [{ type: "text", text }],
				details: d,
			};
		},
	});

	// save_agent --------------------------------------------------------------
	pi.registerTool({
		name: "herdr_save_agent",
		label: "Save agent definition",
		description:
			"Persist an agent definition to the `.md` registry so every session (this one included) " +
			"can spawn it by `type`. Source is EITHER an inline `agent` definition OR the `type` of an " +
			"existing registry entry (session inline, `.md` file, or built-in — saving a copy of a " +
			"built-in to customize it is fine). Target folder: `project` (`.pi/agents/`, default — " +
			"local and reversible) or `global` (the user-wide agents dir). The file is `---` frontmatter " +
			"(`name`, `description`, `kind`, `model`, `thinking`, `session-mode`, `auto-exit`, " +
			"`interactive`, `spawning`, `tools`, `deny-tools`, `skills`, `args`, `cwd`, `prompt_mode`) " +
			"plus the system prompt as the body; unknown keys in hand-written files are ignored (the " +
			"folder is shared with other agent tools). Ungated by design — deleting the file undoes it. " +
			"Refuses to overwrite an existing file unless `overwrite: true`.",
		promptSnippet: "Persist an inline agent definition to the .md registry",
		promptGuidelines: [
			"Use herdr_save_agent when a task defines an agent worth reusing: it writes the .md file the registry resolves by type.",
			"Prefer the project target (reversible via file deletion); go global only when the user asks for a user-wide agent.",
		],
		parameters: Type.Object({
			agent: Type.Optional(AGENT_DEF_SCHEMA),
			type: Type.Optional(
				Type.String({
					description:
						"Registry name of an existing definition to persist (inline definitions must carry a name). Exactly one of type/agent.",
				}),
			),
			target: Type.Optional(
				StringEnum(["project", "global"] as const, {
					description: "Which registry folder to write (default: project).",
				}),
			),
			overwrite: Type.Optional(
				Type.Boolean({
					description:
						"Replace an existing file at the target path (default: refuse).",
				}),
			),
		}),
		async execute(_id, p) {
			const r = saveAgent({
				type: p.type,
				agent: p.agent,
				target: p.target,
				overwrite: p.overwrite,
			});
			if (!r.ok) return fail(r.error.message, r.error.code, r.error.details);
			const d = r.data;
			return {
				content: [
					{
						type: "text",
						text: `Saved agent "${d.name}" to ${d.path} (${d.target} registry) — spawn it by type "${d.name}" in any session.`,
					},
				],
				details: d,
			};
		},
	});
}
