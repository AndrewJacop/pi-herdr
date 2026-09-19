// The v0.5 agent surface — `herdr_spawn_agent`.
//
// One call: resolve the agent (registry `type` or inline `agent`), pass the
// gates, spawn a pane, submit the prompt, return {name, paneId, status}.
// The engine and every decision live in src/spawn.ts + src/agentdefs.ts;
// this file is the thin pi registration (name, description, schema, format).
//
// Tool naming keeps the repo's herdr_ prefix (wayfinder ticket 06's naming
// note: the charter's unprefixed names were shorthand).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { spawnAgent } from "../spawn.js";
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
	"Inline definitions from earlier spawns this session are addressable by `type` too. " +
	"Inline `agent` fields: name, description, kind, model, system_prompt, prompt_mode " +
	"(replace|append, default replace), tools, exclude_tools, skills (pi-only), agent_args " +
	"(raw CLI flags). Honesty rule: a field the chosen kind cannot enforce refuses the spawn " +
	"naming the field — use agent_args or another kind. `kind` (default: settings default_kind, " +
	"'pi') is an unopinionated passthrough onto herdr's native `agent start --kind` axis: a non-pi " +
	"child is text in a pane with a TUI-detected lifecycle, nothing else. " +
	"`kind`/`model` override the definition's. Background by default; `wait: true` blocks until " +
	"done-or-blocked, `wait: <ms>` returns the current state on expiry. At max_parallel_agents the " +
	"spawn is accepted queued (no pane until a slot frees; wait waits through the queue). " +
	"`isolated: true` runs the agent in a fresh auto-created herdr-side git worktree " +
	"(worktree stays after the agent — remove via herdr_worktree_remove). " +
	"Gates, checked in order before any side effect: kill-switch, spawn depth, parallel cap. " +
	"No layout parameters — panes split right in the current tab (surface: full keeps herdr_start_agent).";

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
			agent: Type.Optional(
				Type.Object({
					name: Type.Optional(
						Type.String({
							description:
								"Definition name; registers session-ephemerally (addressable by type later).",
						}),
					),
					description: Type.Optional(Type.String()),
					kind: Type.Optional(
						Type.String({
							description: "Agent kind (default: settings default_kind).",
						}),
					),
					model: Type.Optional(
						Type.String({ description: "Model pin (omit to inherit)." }),
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
				}),
			),
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
		async execute(_id, p, signal) {
			const r = await spawnAgent(
				{
					prompt: p.prompt,
					type: p.type,
					agent: p.agent,
					name: p.name,
					kind: p.kind,
					model: p.model,
					cwd: p.cwd,
					isolated: p.isolated,
					wait: p.wait,
				},
				{ signal },
			);
			if (!r.ok) return fail(r.error.message, r.error.code, r.error.details);
			const d = r.data;
			const where = d.paneId ? `pane ${d.paneId}` : "no pane yet (queued)";
			const type = d.type ? ` (type ${d.type})` : "";
			const text = d.queued
				? `Spawn accepted as QUEUED: "${d.name}"${type} — fleet is at max_parallel_agents; the pane starts when a slot frees.`
				: `Spawned ${d.kind} agent "${d.name}"${type} in ${where}; status: ${d.status}.${d.worktreePath ? ` Isolated worktree: ${d.worktreePath}` : ""}`;
			return {
				content: [{ type: "text", text }],
				details: d,
			};
		},
	});
}
