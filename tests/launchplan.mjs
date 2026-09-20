// Tests for the launch plan builder + routing chain (v0.6 issue 08):
// resolveRouting (5-level precedence, model and thinking independently),
// validateRouting (exact authenticated provider/model-id, errors name the
// level), the task artifact (<session>.task.md + one-line reference),
// identity/mode-hint blocks, and the full-argv goldens (pi + non-pi
// passthrough, frontmatter args: + spawn-level agent_args last-wins).
//
// No live herdr server required: everything here is pure or deps-injected.
//
// Run: node tests/launchplan.mjs

import { createJiti } from "jiti";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url);

let passed = 0;
let failed = 0;
function assert(cond, msg) {
	if (cond) {
		passed++;
		console.log(`  ✓ ${msg}`);
	} else {
		failed++;
		console.error(`  ✗ ${msg}`);
	}
}
function eq(a, b) {
	return JSON.stringify(a) === JSON.stringify(b);
}

const lp = await jiti.import(join(ROOT, "src/launchplan.ts"), {
	parent: ROOT,
});
const spawn = await jiti.import(join(ROOT, "src/spawn.ts"), { parent: ROOT });
const settingsMod = await jiti.import(join(ROOT, "src/settings.ts"), {
	parent: ROOT,
});

// ---------------------------------------------------------------------------
console.log("\n[1] resolveRouting — 5-level precedence");
{
	// All unset → unset sources, no values.
	const none = lp.resolveRouting({ settings: { models: { default: "", agents: {} } } });
	assert(none.model === undefined && none.modelSource === "unset", "nothing set → model unset");
	assert(none.thinking === undefined && none.thinkingSource === "unset", "nothing set → thinking unset");

	// Level 1 (spawn) wins over everything.
	const l1 = lp.resolveRouting({
		spawn: { model: "prov/m1", thinking: "high" },
		definition: { name: "scout", model: "prov/m2", thinking: "low" },
		settings: { models: { default: "prov/m3", agents: { scout: "prov/m4" } } },
		parent: { model: { provider: "prov", id: "m5" } },
	});
	assert(l1.model === "prov/m1" && l1.modelSource === "spawn", "level 1 model wins");
	assert(l1.thinking === "high" && l1.thinkingSource === "spawn", "level 1 thinking wins");

	// Level 2 (frontmatter) wins over settings + parent.
	const l2 = lp.resolveRouting({
		definition: { name: "scout", model: "prov/m2", thinking: "low" },
		settings: { models: { default: "prov/m3", agents: { scout: "prov/m4" } } },
		parent: { model: { provider: "prov", id: "m5" } },
	});
	assert(l2.model === "prov/m2" && l2.modelSource === "frontmatter", "level 2 model wins");
	assert(l2.thinking === "low" && l2.thinkingSource === "frontmatter", "level 2 thinking wins");

	// Level 3 (models.agents.<name>) wins over default + parent.
	const l3 = lp.resolveRouting({
		definition: { name: "scout" },
		settings: { models: { default: "prov/m3", agents: { scout: "prov/m4" } } },
		parent: { model: { provider: "prov", id: "m5" } },
	});
	assert(l3.model === "prov/m4" && l3.modelSource === "agents-pin", "level 3 model wins");
	assert(l3.thinkingSource === "unset", "level 3 thinking unset → falls to unset (no explicit pin)");

	// Level 4 (models.default) wins over parent.
	const l4 = lp.resolveRouting({
		definition: { name: "scout" },
		settings: { models: { default: "prov/m3", agents: {} } },
		parent: { model: { provider: "prov", id: "m5" } },
	});
	assert(l4.model === "prov/m3" && l4.modelSource === "models-default", "level 4 model wins");

	// Level 5 (parent) adopted — exact provider/id string, thinking NOT inherited.
	const l5 = lp.resolveRouting({
		settings: { models: { default: "", agents: {} } },
		parent: { model: { provider: "anthropic", id: "claude-opus-4-6" } },
	});
	assert(
		l5.model === "anthropic/claude-opus-4-6" && l5.modelSource === "parent",
		"level 5 model = parent's provider/id",
	);
	assert(
		l5.thinking === undefined && l5.thinkingSource === "unset",
		"level 5 thinking is a no-op (child keeps its own default)",
	);

	// Level 5 with no parent model → unset.
	const noParent = lp.resolveRouting({ settings: { models: { default: "", agents: {} } } });
	assert(noParent.modelSource === "unset", "no parent model → unset");

	// "" settings entries are unset (documented settings semantics).
	const empty = lp.resolveRouting({
		definition: { name: "scout" },
		settings: { models: { default: "", agents: { scout: "" } } },
		parent: { model: { provider: "prov", id: "m5" } },
	});
	assert(empty.model === "prov/m5" && empty.modelSource === "parent", "empty pin + empty default fall through to parent");

	// Level-3 lookup keys on the definition name; anonymous (no name) skips it.
	const anon = lp.resolveRouting({
		definition: {},
		settings: { models: { default: "", agents: { scout: "prov/m4" } } },
		parent: { model: { provider: "prov", id: "m5" } },
	});
	assert(anon.model === "prov/m5", "anonymous definition skips the agents-pin level");

	// "" is unset at EVERY level (uniform semantics, matches settings docs).
	const blank = lp.resolveRouting({
		spawn: { model: "", thinking: "" },
		settings: { models: { default: "", agents: {} } },
		parent: { model: { provider: "prov", id: "m5" } },
	});
	assert(
		blank.model === "prov/m5" && blank.modelSource === "parent",
		"blank strings are unset at every level",
	);

	// Thinking resolves independently of model.
	const mixed = lp.resolveRouting({
		spawn: { model: "prov/m1" },
		definition: { name: "scout", thinking: "low" },
		settings: { models: { default: "prov/m3", agents: {} } },
		parent: { model: { provider: "prov", id: "m5" } },
	});
	assert(mixed.model === "prov/m1" && mixed.modelSource === "spawn", "mixed: model from spawn");
	assert(mixed.thinking === "low" && mixed.thinkingSource === "frontmatter", "mixed: thinking from frontmatter");
}

// ---------------------------------------------------------------------------
console.log("\n[2] validateRouting — enforce-or-error, errors name the level");
{
	// Fake registry: exact find() + auth check, like pi's ModelRegistry.
	const registry = (models, authed = new Set()) => ({
		find: (provider, id) =>
			(models ?? []).find((m) => m.provider === provider && m.id === id),
		hasConfiguredAuth: (m) => authed.has(`${m.provider}/${m.id}`),
	});
	const cat = [
		{ provider: "anthropic", id: "claude-opus-4-6" },
		{ provider: "openai", id: "gpt-5.2" },
	];
	const authed = new Set(["anthropic/claude-opus-4-6"]);
	const reg = registry(cat, authed);
	const capsPi = { model: true, systemPrompt: true, tools: true, excludeTools: true, skills: true, thinking: true };
	const capsClaude = { ...capsPi, thinking: false };

	// A fully valid resolution passes.
	const good = lp.validateRouting(
		{ model: "anthropic/claude-opus-4-6", modelSource: "agents-pin", thinkingSource: "unset", thinking: undefined },
		capsPi,
		reg,
		"scout",
	);
	assert(good === null, "valid model + no thinking → no error");

	// Bare id (no provider) — rejected, names the level.
	const bare = lp.validateRouting(
		{ model: "gpt-5.2", modelSource: "frontmatter", thinking: undefined, thinkingSource: "unset" },
		capsPi,
		reg,
		"scout",
	);
	assert(bare !== null && /level 2 \(frontmatter of "scout"\)/.test(bare.error.message), `bare id names the level (${bare && bare.error.message})`);
	assert(bare && bare.error.code === "VALIDATION_ERROR", "bare id → VALIDATION_ERROR");

	// Unknown model id — names the level.
	const unknown = lp.validateRouting(
		{ model: "anthropic/claude-haiku-9", modelSource: "spawn", thinking: undefined, thinkingSource: "unset" },
		capsPi,
		reg,
	);
	assert(unknown !== null && /level 1 \(spawn param\)/.test(unknown.error.message), `unknown id names the level (${unknown && unknown.error.message})`);

	// Known model, unauthenticated provider — names the level.
	const noAuth = lp.validateRouting(
		{ model: "openai/gpt-5.2", modelSource: "models-default", thinking: undefined, thinkingSource: "unset" },
		capsPi,
		reg,
	);
	assert(
		noAuth !== null && /level 4 \(models\.default\)/.test(noAuth.error.message) && /auth/i.test(noAuth.error.message),
		`unauthenticated provider names the level (${noAuth && noAuth.error.message})`,
	);

	// Bad thinking enum — names the level.
	const badThink = lp.validateRouting(
		{ model: undefined, modelSource: "unset", thinking: "ultra", thinkingSource: "agents-pin" },
		capsPi,
		reg,
		"scout",
	);
	assert(
		badThink !== null && /level 3 \(models\.agents pin for "scout"\)/.test(badThink.error.message),
		`bad thinking names the level (${badThink && badThink.error.message})`,
	);

	// Every valid pi thinking level passes.
	for (const lvl of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
		const ok = lp.validateRouting(
			{ thinking: lvl, thinkingSource: "spawn", model: undefined, modelSource: "unset" },
			capsPi,
			reg,
		);
		assert(ok === null, `thinking "${lvl}" is valid`);
	}

	// Explicit thinking on a thinking-incapable kind errors naming the level AND the kind.
	const noThinkKind = lp.validateRouting(
		{ thinking: "high", thinkingSource: "frontmatter", model: undefined, modelSource: "unset" },
		capsClaude,
		reg,
		"scout",
		"claude",
	);
	assert(
		noThinkKind !== null && /level 2/.test(noThinkKind.error.message) && /kind "claude"/.test(noThinkKind.error.message),
		`thinking on incapable kind names level + kind (${noThinkKind && noThinkKind.error.message})`,
	);

	// No registry + a model to validate → honest refusal (inside the validator).
	const noReg = lp.validateRouting(
		{ model: "prov/m-ok", modelSource: "frontmatter", thinking: undefined, thinkingSource: "unset" },
		capsPi,
		undefined,
		"scout",
	);
	assert(noReg !== null && /no model registry/.test(noReg.error.message) && /level 2/.test(noReg.error.message), `no registry refused naming level (${noReg && noReg.error.message})`);

	// Parent-level (level 5) values validate uniformly (error path is
	// theoretical — the parent's own model is live — but the naming must hold).
	const l5bad = lp.validateRouting(
		{ model: "nope/nope", modelSource: "parent", thinking: undefined, thinkingSource: "unset" },
		capsPi,
		reg,
	);
	assert(l5bad !== null && /level 5 \(parent session\)/.test(l5bad.error.message), `level 5 names itself (${l5bad && l5bad.error.message})`);
}

// ---------------------------------------------------------------------------
console.log("\n[3] task artifact — long tasks ride a file beside the session");
{
	const writes = [];
	const deps = { writeFile: (path, text) => writes.push([path, text]) };
	const session = "/sessions/--C--Me-proj--/2026-09-20T00-00-00-000Z_uuid.jsonl";
	const artifact = `${session}.task.md`;

	// Short prompt → inline, no file.
	const short = lp.buildTaskPrompt("do the thing", session, deps);
	assert(short.ok && short.data.prompt === "do the thing" && !short.data.artifactPath, "short prompt stays inline");
	assert(writes.length === 0, "no write for a short prompt");

	// Boundary: exactly THRESHOLD chars → inline; one more → artifact.
	const edge = lp.buildTaskPrompt("x".repeat(lp.TASK_ARTIFACT_THRESHOLD), session, deps);
	assert(edge.ok && !edge.data.artifactPath, "exactly-threshold prompt stays inline");
	const over = lp.buildTaskPrompt("x".repeat(lp.TASK_ARTIFACT_THRESHOLD + 1), session, deps);
	assert(over.ok && over.data.artifactPath === artifact, "over-threshold prompt → <session>.task.md");
	assert(eq(writes, [[artifact, "x".repeat(lp.TASK_ARTIFACT_THRESHOLD + 1)]]), "artifact file carries the verbatim task");

	// The submitted prompt is ONE line referencing the artifact.
	assert(
		over.ok && !/[\r\n]/.test(over.data.prompt) && over.data.prompt.includes(artifact),
		`one-line reference (${over.ok ? over.data.prompt : over.error.message})`,
	);

	// No session (non-pi) → never an artifact, even when long.
	const noSession = lp.buildTaskPrompt("x".repeat(9999), undefined, deps);
	assert(noSession.ok && noSession.data.prompt === "x".repeat(9999) && !noSession.data.artifactPath, "no session → inline even when long");

	// Write failure → clean error, no fake prompt.
	const boom = lp.buildTaskPrompt("x".repeat(9999), session, {
		writeFile: () => {
			throw new Error("disk full");
		},
	});
	assert(!boom.ok && /disk full/.test(boom.error.message), "write failure → AGENT_START_FAILED naming the cause");
}

// ---------------------------------------------------------------------------
console.log("\n[4] identity + mode-hint blocks — lean, golden strings");
{
	assert(
		lp.buildIdentityBlock({ name: "scout", type: "Explore" }) ===
			"You are herdr/scout (type: Explore), spawned by a pi-herdr orchestrator.",
		"identity block golden (named type)",
	);
	assert(
		lp.buildIdentityBlock({ name: "scout" }) ===
			"You are herdr/scout, spawned by a pi-herdr orchestrator.",
		"identity block golden (anonymous inline)",
	);

	assert(
		lp.buildModeHintBlock({ stance: "autonomous", sessionMode: "standalone" }) ===
			"When your task is complete, write your full final summary as a normal message; settling ends your run (agent_done declares it).",
		"autonomous mode-hint golden",
	);
	assert(
		lp.buildModeHintBlock({ stance: "interactive", sessionMode: "standalone" }) === "",
		"interactive + standalone → no mode hint",
	);
	assert(
		lp.buildModeHintBlock({ stance: "interactive", sessionMode: "fork" }) ===
			"Your session was seeded from a parent conversation; treat earlier turns as context, not your own actions.",
		"fork mode-hint golden",
	);
	assert(
		lp.buildModeHintBlock({ stance: "autonomous", sessionMode: "lineage-only" }).includes("seeded from a parent conversation"),
		"lineage-only gets the seeded-context note too",
	);

	// Flag composition: replace default, append mode, and the empty case.
	const flags = (o) =>
		lp.composePromptFlags({
			defPrompt: o.prompt ?? "",
			promptMode: o.mode ?? "replace",
			identity: o.identity ?? "",
			modeHint: o.hint ?? "",
		});
	assert(eq(flags({}), []), "nothing to say → no flags");
	assert(
		eq(flags({ prompt: "P", identity: "I", hint: "H" }), [
			"--system-prompt", "P",
			"--append-system-prompt", "I\nH",
		]),
		"replace: def prompt on --system-prompt, blocks on --append-system-prompt",
	);
	assert(
		eq(flags({ prompt: "P", mode: "append", identity: "I", hint: "H" }), [
			"--append-system-prompt", "P\nI\nH",
		]),
		"append: one combined --append-system-prompt value",
	);
	assert(
		eq(flags({ identity: "I" }), ["--append-system-prompt", "I"]),
		"blocks alone still ride --append-system-prompt",
	);
}

// ---------------------------------------------------------------------------
console.log("\n[5] buildLaunchPlan — full argv goldens");
{
	const base = {
		kind: "pi",
		sessionPath: "/sessions/--C--Me-proj--/s.jsonl",
		childExtension: "/ext/child.ts",
	};

	// Bare pi child: session + extension, nothing else.
	assert(
		eq(lp.buildLaunchPlan(base), [
			"--session", "/sessions/--C--Me-proj--/s.jsonl",
			"-e", "/ext/child.ts",
		]),
		"pi default argv: --session → -e",
	);

	// Spec flags ride after the substrate; raw flags are part of specFlags
	// (buildAgentArgs appends them last — see [6] for the def-vs-spawn order).
	assert(
		eq(
			lp.buildLaunchPlan({
				...base,
				specFlags: ["--model", "prov/m", "--thinking", "high", "--plan"],
			}),
			[
				"--session", "/sessions/--C--Me-proj--/s.jsonl",
				"-e", "/ext/child.ts",
				"--model", "prov/m", "--thinking", "high",
				"--plan",
			],
		),
		"pi argv order: substrate → spec flags (routing + raw args last)",
	);

	// Last-wins override shape: spawn-level agent_args repeat a flag AFTER the
	// definition's pin — covered end to end in [6]; here, one composed argv.
	const override = lp.buildLaunchPlan({
		...base,
		specFlags: ["--model", "prov/from-frontmatter", "--model", "prov/from-spawn"],
	});
	assert(
		override.indexOf("prov/from-spawn") > override.indexOf("prov/from-frontmatter"),
		"later duplicate flags win (last-wins override)",
	);

	// Non-pi: honest passthrough — no substrate, no --session leakage.
	assert(
		eq(
			lp.buildLaunchPlan({
				kind: "claude",
				sessionPath: "/should/not/leak.jsonl",
				childExtension: "/ext/child.ts",
				specFlags: ["--model", "prov/m", "--continue"],
			}),
			["--model", "prov/m", "--continue"],
		),
		"non-pi passthrough: spec flags only",
	);
}

// ---------------------------------------------------------------------------
console.log("\n[6] routing end to end through spawnAgent (fakes)");
{
	// Minimal spawn-engine harness (same discipline as tests/spawn.mjs).
	function makeDeps(opts = {}) {
		const calls = { start: [], submit: [], seed: [] };
		const live = [];
		return {
			calls,
			live,
			deps: {
				load: () => ({
					...settingsMod.DEFAULT_SETTINGS,
					models: {
						default: opts.modelsDefault ?? "",
						agents: opts.modelsAgents ?? {},
					},
				}),
				kinds: async () => ["pi", "claude"],
				list: async () => [],
				start: async (input) => {
					calls.start.push(input);
					const paneId = `p${calls.start.length}`;
					live.push({ name: input.name, paneId, agent_status: "idle" });
					return { ok: true, data: { agent: { pane_id: paneId } } };
				},
				boot: async () => ({ ok: true, data: true }),
				submit: async (paneId, text) => {
					calls.submit.push({ paneId, text });
					return { ok: true, data: true };
				},
				status: async (paneId) => {
					const a = live.find((x) => x.paneId === paneId);
					return a
						? { ok: true, data: a.agent_status }
						: { ok: false, error: { code: "NOT_FOUND", message: "gone" } };
				},
				seed: (cwd) => {
					calls.seed.push(cwd);
					return { path: `D:/tmp/s/${calls.seed.length}.jsonl`, dir: "D:/tmp/s" };
				},
				childExtension: "D:/ext/child.ts",
				env: {},
				autodrain: false,
				registry: opts.registry,
				parent: opts.parent,
			},
		};
	}
	const reg = {
		find: (p, id) =>
			p === "prov" && id === "m-ok" ? { provider: p, id } : undefined,
		hasConfiguredAuth: (m) => m.provider === "prov",
	};

	// Bad settings pin → refused, error names level 3, NO pane side effect.
	{
		spawn.clearSpawnRegistry();
		const h = makeDeps({ modelsAgents: { Explore: "prov/not-a-model" }, registry: reg });
		const r = await spawn.spawnAgent({ prompt: "x", type: "Explore", name: "a1" }, h.deps);
		assert(
			!r.ok && /level 3 \(models\.agents pin for "Explore"\)/.test(r.error.message),
			`bad settings pin refused naming level 3 (${r.ok ? "spawned!" : r.error.message})`,
			);
		assert(h.calls.start.length === 0, "no pane on routing refusal");
	}

	// Valid settings pin → argv carries --model pin; result surfaces it.
	{
		spawn.clearSpawnRegistry();
		const h = makeDeps({ modelsAgents: { Explore: "prov/m-ok" }, registry: reg });
		const r = await spawn.spawnAgent({ prompt: "x", type: "Explore", name: "a2" }, h.deps);
		assert(r.ok, `spawn ok (${r.ok ? "" : r.error.message})`);
		assert(
			h.calls.start[0].agentArgs.includes("--model") &&
				h.calls.start[0].agentArgs.includes("prov/m-ok"),
			"settings pin lands on the argv",
		);
		assert(r.data.model === "prov/m-ok", "result surfaces the resolved model");
		assert(h.calls.start[0].agentArgs.includes("--append-system-prompt"), "identity/mode-hint blocks appended for pi children");
	}

	// Spawn-level model (level 1) beats the settings pin; level-1 thinking → flag.
	{
		spawn.clearSpawnRegistry();
		const h = makeDeps({ modelsAgents: { Explore: "prov/m-ok" }, registry: reg });
		const r = await spawn.spawnAgent(
			{ prompt: "x", type: "Explore", name: "a3", model: "prov/m-ok", thinking: "low" },
			h.deps,
		);
		assert(r.ok && r.data.thinking === "low", "result surfaces resolved thinking");
		const args = h.calls.start[0].agentArgs;
		assert(
			args.lastIndexOf("prov/m-ok") === args.length - 1 || args.indexOf("--thinking") > -1,
			"argv carries the spawn-level thinking flag",
		);
		assert(
			args.filter((a) => a === "--model").length === 1,
			"one --model flag total (routing resolves BEFORE the flag is emitted)",
		);
	}

	// Spawn-level agent_args appended after the definition's (frontmatter args:).
	{
		spawn.clearSpawnRegistry();
		const h = makeDeps({ registry: reg });
		const r = await spawn.spawnAgent(
			{
				prompt: "x",
				name: "a4",
				agent: {
					name: "planner",
					agent_args: ["--plan"],
				},
				agent_args: ["--verbose"],
			},
			h.deps,
		);
		assert(r.ok, `inline def spawn ok (${r.ok ? "" : r.error.message})`);
		const args = h.calls.start[0].agentArgs;
		assert(
			args.indexOf("--plan") > -1 && args.indexOf("--verbose") > args.indexOf("--plan"),
			"def args (frontmatter args:) precede spawn-level agent_args",
		);
	}

	// CB3 end to end: a multi-KB task spawns via artifact + one-line reference.
	{
		spawn.clearSpawnRegistry();
		const h = makeDeps({ registry: reg });
		const realDir = mkdtempSync(join(tmpdir(), "pi-herdr-lp-"));
		h.deps.seed = () => ({
			path: join(realDir, "seeded.jsonl"),
			dir: realDir,
		});
		const longTask = "Do all of this:\n" + "- step\n".repeat(600); // > 2000 chars
		const r = await spawn.spawnAgent({ prompt: longTask, type: "Plan", name: "a4b" }, h.deps);
		assert(r.ok, `long-task spawn ok (${r.ok ? "" : r.error.message})`);
		const submitted = h.calls.submit[0].text;
		assert(
			!/[\r\n]/.test(submitted) && submitted.endsWith("seeded.jsonl.task.md and execute it; the file is the complete task."),
			`submitted prompt is the one-line reference (${submitted.slice(0, 90)}…)`,
			);
		const artifact = join(realDir, "seeded.jsonl.task.md");
		assert(
			existsSync(artifact) && readFileSync(artifact, "utf8") === longTask,
			"artifact file carries the verbatim multi-KB task",
		);
		const rec = [...spawn.spawnRecords().values()].find((x) => x.name === "a4b");
		assert(rec && rec.taskArtifactPath === artifact, "record stamps the artifact path");
		rmSync(realDir, { recursive: true, force: true });
	}

	// Level-5 model on a kind that cannot enforce a model flag is a NO-OP
	// (unknown kind): the spawn proceeds without --model, not a refusal.
	{
		spawn.clearSpawnRegistry();
		const h = makeDeps({
			parent: { model: { provider: "prov", id: "m-ok" } },
			registry: reg,
		});
		h.deps.kinds = async () => ["pi", "mystery"];
		const r = await spawn.spawnAgent(
			{ prompt: "x", name: "a4c", kind: "mystery", agent: { name: "anon" } },
			h.deps,
		);
		assert(r.ok, `unknown-kind spawn ok (${r.ok ? "" : r.error.message})`);
		assert(
			!h.calls.start[0].agentArgs.includes("--model"),
			"level-5 model skipped for a kind without model support (no-op, not refusal)",
			);
	}

	// Parent model (level 5) pinned when the chain falls through; no registry →
	// an honest refusal rather than an unvalidated flag.
	{
		spawn.clearSpawnRegistry();
		const h = makeDeps({ parent: { model: { provider: "prov", id: "m-ok" } }, registry: reg });
		const r = await spawn.spawnAgent({ prompt: "x", type: "Plan", name: "a5" }, h.deps);
		assert(r.ok && r.data.model === "prov/m-ok", `parent model inherited (${r.ok ? "" : r.error.message})`);

		spawn.clearSpawnRegistry();
		const h2 = makeDeps({ parent: { model: { provider: "prov", id: "m-ok" } } });
		const r2 = await spawn.spawnAgent({ prompt: "x", type: "Plan", name: "a6" }, h2.deps);
		assert(
			!r2.ok && /registry/.test(r2.error.message) && /level 5/.test(r2.error.message),
			`no registry + model to pin → honest error naming level 5 (${r2.ok ? "spawned!" : r2.error.message})`,
		);
	}

	// session_mode rides the plan: record + result.
	{
		spawn.clearSpawnRegistry();
		const h = makeDeps({ registry: reg });
		const r = await spawn.spawnAgent(
			{ prompt: "x", name: "a7", agent: { name: "forked", session_mode: "fork" } },
			h.deps,
		);
		assert(r.ok && r.data.session_mode === "fork", "result surfaces session_mode");
		const rec = [...spawn.spawnRecords().values()].find((x) => x.name === "a7");
		assert(rec && rec.session_mode === "fork", "registry record carries session_mode");
		assert(rec && rec.routing !== undefined, "registry record carries the routing resolution");
	}
}

console.log(
	`\n${failed === 0 ? "✅ ALL PASS" : "❌ SOME FAILED"} (${passed}/${passed + failed})`,
);
process.exit(failed === 0 ? 0 : 1);
