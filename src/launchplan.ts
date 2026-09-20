// The launch plan builder (v0.6 issue 08): ONE function composes the argv
// handed to `agent start --kind <kind> -- <argv>` for every spawn, plus the
// 5-level model/thinking routing chain that feeds it.
//
// Decided by wayfinder/tickets/04-launch-plan-routing.md (research §5–6):
//   - routing: spawn param > frontmatter > models.agents.<name> (settings) >
//     models.default (settings) > parent session's model; thinking resolves
//     identically — EXCEPT level 5, which for thinking is a no-op (the child
//     keeps its own configured default; only the model is pinned from the
//     parent, user decision on issue 08).
//   - enforce-or-error: exact authenticated `provider/model-id` only, no
//     fuzzy resolution, and every error names the level that supplied the
//     bad value.
//   - herdr stays the launcher; non-pi kinds remain honest one-liner
//     passthrough — no multi-harness driver layer.
//   - long tasks are written to an artifact file beside the parent-owned
//     session file and referenced by a one-line prompt (argv/typing-length
//     safe; the artifact must outlive the pane so resume works).
//   - identity + mode-hint blocks are appended to every pi child's system
//     prompt (lean wording; see the builders below).
//   - frontmatter `args:` (definition agent_args) and spawn-level agent_args
//     append last-wins — the sanctioned raw-CLI escape hatch.

import type { Err, Result } from "./env.js";
import type { HerdrSettings } from "./settings.js";
import { writeFileSync } from "node:fs";

// ---- routing chain -----------------------------------------------------------

/** Which routing level supplied a value ("unset" = none did). */
export type RoutingLevel =
	| "spawn"
	| "frontmatter"
	| "agents-pin"
	| "models-default"
	| "parent"
	| "unset";

/** The parent session's routing inputs (threaded from the tool's pi ctx). */
export interface ParentRouting {
	/** The parent's active model. Undefined = nothing to inherit. */
	model?: { provider: string; id: string };
}

/** What the chain resolved, with the supplying level for every value. */
export interface RoutingResolution {
	model?: string;
	thinking?: string;
	modelSource: RoutingLevel;
	thinkingSource: RoutingLevel;
}

/** Human label for a level, naming the agent definition where relevant. */
export function routingLevelLabel(
	level: RoutingLevel,
	definitionName?: string,
): string {
	const n = definitionName?.trim();
	switch (level) {
		case "spawn":
			return "routing level 1 (spawn param)";
		case "frontmatter":
			return `routing level 2 (frontmatter${n ? ` of "${n}"` : ""})`;
		case "agents-pin":
			return `routing level 3 (models.agents pin${n ? ` for "${n}"` : ""})`;
		case "models-default":
			return "routing level 4 (models.default)";
		case "parent":
			return "routing level 5 (parent session)";
		case "unset":
			return "routing (unset)";
		default:
			return "routing (unknown level)";
	}
}

/** The pi thinking levels accepted by `--thinking` (pi README). */
export const THINKING_LEVELS: ReadonlySet<string> = new Set([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);

/** "" is unset in settings (documented semantics); undefined likewise. */
function nonEmpty(v: string | undefined): string | undefined {
	return v && v.trim() ? v : undefined;
}

/**
 * Resolve the 5-level routing chain for model and thinking. Pure. Settings
 * values are read by the caller (hot-reload rule); "" entries are unset.
 * Thinking never inherits from the parent (level 5 = no-op, user decision).
 */
export function resolveRouting(input: {
	spawn?: { model?: string; thinking?: string };
	definition?: { name?: string; model?: string; thinking?: string };
	settings?: Pick<HerdrSettings, "models">;
	parent?: ParentRouting;
}): RoutingResolution {
	const agentName = input.definition?.name?.trim() || "";
	const pin = agentName
		? (input.settings?.models?.agents?.[agentName] ?? undefined)
		: undefined;
	const parentModel = input.parent?.model
		? `${input.parent.model.provider}/${input.parent.model.id}`
		: undefined;

	const model = [
		[input.spawn?.model, "spawn"],
		[input.definition?.model, "frontmatter"],
		[nonEmpty(pin), "agents-pin"],
		[nonEmpty(input.settings?.models?.default), "models-default"],
		[parentModel, "parent"],
	].find(([v]) => nonEmpty(v));
	const thinking = [
		[input.spawn?.thinking, "spawn"],
		[input.definition?.thinking, "frontmatter"],
	].find(([v]) => nonEmpty(v));

	return {
		model: model?.[0],
		modelSource: (model?.[1] ?? "unset") as RoutingLevel,
		thinking: thinking?.[0],
		thinkingSource: (thinking?.[1] ?? "unset") as RoutingLevel,
	};
}

// ---- validation (enforce-or-error) --------------------------------------------

/** The capability routing validation cares about (subset of spawn's KindCaps). */
export interface RoutingCaps {
	thinking: boolean;
}

/** The registry surface routing validation needs (pi's ModelRegistry). */
export interface RoutingRegistry {
	find(provider: string, modelId: string): { provider: string; id: string } | undefined;
	hasConfiguredAuth(model: { provider: string; id: string }): boolean;
}

/**
 * Enforce-or-error on a resolved routing: exact authenticated
 * `provider/model-id` only (no fuzzy resolution, no bare ids), thinking must
 * be a valid pi level, and an explicit thinking value on a kind without a
 * thinking flag refuses. EVERY error names the level that supplied the value
 * (ticket 04 decision 5). Pure; the registry is injected (fakes in tests) —
 * undefined means no registry is reachable, which refuses any model pin
 * rather than letting an unvalidated flag through.
 */
export function validateRouting(
	resolved: RoutingResolution,
	caps: RoutingCaps,
	registry: RoutingRegistry | undefined,
	definitionName?: string,
	kind?: string,
): Err | null {
	const name = definitionName?.trim() || undefined;
	if (resolved.model) {
		const label = routingLevelLabel(resolved.modelSource, name);
		const slash = resolved.model.indexOf("/");
		if (slash <= 0 || slash === resolved.model.length - 1) {
			return routingErr(
				`model "${resolved.model}" from ${label}: not an exact provider/model-id — pass "provider/model-id" (no fuzzy resolution).`,
			);
		}
		if (!registry) {
			return routingErr(
				`model "${resolved.model}" from ${label}: no model registry available to validate against (exact authenticated provider/model-id required).`,
			);
		}
		const provider = resolved.model.slice(0, slash);
		const id = resolved.model.slice(slash + 1);
		const model = registry.find(provider, id);
		if (!model) {
			return routingErr(
				`model "${resolved.model}" from ${label}: no such model in pi's model registry — exact provider/model-id required.`,
			);
		}
		if (!registry.hasConfiguredAuth(model)) {
			return routingErr(
				`model "${resolved.model}" from ${label}: provider "${provider}" has no configured authentication.`,
			);
		}
	}
	if (resolved.thinking) {
		const label = routingLevelLabel(resolved.thinkingSource, name);
		if (!THINKING_LEVELS.has(resolved.thinking)) {
			return routingErr(
				`thinking "${resolved.thinking}" from ${label}: must be one of ${[...THINKING_LEVELS].join("|")}.`,
			);
		}
		if (!caps.thinking) {
			return routingErr(
				`thinking "${resolved.thinking}" from ${label}: kind "${kind ?? "unknown"}" cannot enforce thinking — use a kind with a thinking flag (pi) or drop the pin.`,
			);
		}
	}
	return null;
}

// ---- the launch plan builder --------------------------------------------------

export interface LaunchPlanInput {
	kind: string;
	/** Parent-owned session file (pi children; seeded before launch). */
	sessionPath?: string;
	/** Injected child extension (pi children). */
	childExtension?: string;
	/** The spec's own flags (prompt/model/thinking/tools + raw agent_args,
	 *  composed by the spawn engine's buildAgentArgs). */
	specFlags?: string[];
}

/**
 * ONE builder for the argv handed to `agent start --kind <kind> -- <argv>`
 * (wayfinder ticket 04 decision 1+4). pi children carry the parent-owned
 * substrate (`--session`, `-e child.ts`) ahead of the spec's own flags; every
 * other kind is the honest one-liner passthrough — no multi-harness drivers.
 */
export function buildLaunchPlan(input: LaunchPlanInput): string[] {
	const args: string[] = [];
	if (input.kind.toLowerCase() === "pi") {
		if (input.sessionPath) args.push("--session", input.sessionPath);
		if (input.childExtension) args.push("-e", input.childExtension);
	}
	args.push(...(input.specFlags ?? []));
	return args;
}

// ---- identity + mode-hint blocks (lean; wording pinned by issue 08) -----------

/** Who the child is: `herdr/<name>` (+ registry type when it has one). */
export function buildIdentityBlock(child: {
	name: string;
	type?: string;
}): string {
	const type = child.type?.trim();
	return type
		? `You are herdr/${child.name} (type: ${type}), spawned by a pi-herdr orchestrator.`
		: `You are herdr/${child.name}, spawned by a pi-herdr orchestrator.`;
}

/**
 * How the child runs: the settle contract for autonomous stance, and the
 * seeded-lineage note for fork/lineage-only sessions. Interactive + standalone
 * children need no hint (empty string → no flag is emitted).
 */
export function buildModeHintBlock(child: {
	stance: "autonomous" | "interactive";
	sessionMode?: "standalone" | "lineage-only" | "fork";
}): string {
	const lines: string[] = [];
	if (child.stance === "autonomous") {
		lines.push(
			"When your task is complete, write your full final summary as a normal message; settling ends your run (agent_done declares it).",
		);
	}
	if (child.sessionMode === "lineage-only" || child.sessionMode === "fork") {
		lines.push(
			"Your session was seeded from a parent conversation; treat earlier turns as context, not your own actions.",
		);
	}
	return lines.join("\n");
}

/**
 * Compose the system-prompt flags for a pi child: the definition's prompt on
 * `--system-prompt` (replace default) or folded into one combined
 * `--append-system-prompt` value (append mode); the identity/mode-hint blocks
 * always append. Multiline values are materialized to temp files later by the
 * spawn engine's materializeAgentArgs (house practice). Empty everything →
 * no flags at all.
 */
export function composePromptFlags(io: {
	defPrompt?: string;
	promptMode?: "replace" | "append";
	identity?: string;
	modeHint?: string;
}): string[] {
	const defPrompt = io.defPrompt?.trim() ? io.defPrompt : "";
	const blocks = [io.identity?.trim(), io.modeHint?.trim()]
		.filter((s): s is string => Boolean(s))
		.join("\n");
	if (!defPrompt && !blocks) return [];
	if (io.promptMode === "append" && defPrompt) {
		const value = blocks ? `${defPrompt}\n${blocks}` : defPrompt;
		return ["--append-system-prompt", value];
	}
	const flags: string[] = [];
	if (defPrompt) flags.push("--system-prompt", defPrompt);
	if (blocks) flags.push("--append-system-prompt", blocks);
	return flags;
}

// ---- task artifact (long tasks ride a file, one-line reference) ---------------

/** Prompts longer than this are written to `<session>.task.md` and referenced
 * by a one-line prompt (argv/typing-length safe; user decision: the artifact
 * lives beside the parent-owned session file so resume finds it). */
export const TASK_ARTIFACT_THRESHOLD = 2000;

const TASK_ONE_LINER = (path: string): string =>
	`Read your task from ${path} and execute it; the file is the complete task.`;

export interface TaskPromptDeps {
	writeFile?: (path: string, text: string) => void;
}

/**
 * Pass the task through, or — when it is long and a parent-owned session file
 * exists — write `<session>.task.md` beside the session and return the
 * one-line reference instead. The artifact carries the verbatim prompt; the
 * session dir is never cleaned, so issue 10 resume can re-read it. Returns a
 * clean error on write failure: the spawn must not boot with a lost task.
 */
export function buildTaskPrompt(
	prompt: string,
	sessionPath: string | undefined,
	deps: TaskPromptDeps = {},
): Result<{ prompt: string; artifactPath?: string }> {
	if (!sessionPath || prompt.length <= TASK_ARTIFACT_THRESHOLD) {
		return { ok: true, data: { prompt } };
	}
	const path = `${sessionPath}.task.md`;
	try {
		(deps.writeFile ?? ((p, t) => writeFileSync(p, t, "utf8")))(path, prompt);
	} catch (e) {
		return {
			ok: false,
			error: {
				code: "AGENT_START_FAILED",
				message: `could not write the task artifact ${path}: ${e instanceof Error ? e.message : String(e)}`,
			},
		};
	}
	return { ok: true, data: { prompt: TASK_ONE_LINER(path), artifactPath: path } };
}

export function routingErr(message: string): Err {
	return { ok: false, error: { code: "VALIDATION_ERROR", message } };
}
