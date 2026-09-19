// Tests for the spawn_agent tracer bullet (issue 02): specifier xor, the
// verbatim built-in trio, the name fallback chain, kind/model merge with
// enforce-or-error, the gate order (kill-switch → depth → cap), the queued
// spawn + drain, isolated worktrees, the wait vocabulary, and the child env
// contract (PI_HERDR_SPAWN_DEPTH / PI_HERDR_ORCHESTRATOR_PANE).
//
// No live herdr server required: every herdr-facing seam is injected, and no
// test depends on wall-clock timing — fakes settle instantly and `wait: 0`
// exercises expiry paths deterministically.
//
// NOTE: agentdefs APIs are consumed through src/spawn.ts's re-exports — the
// session registry is mutable module state and must have exactly ONE jiti
// instance in this process (importing src/agentdefs.ts directly here would
// create a second, split-brain instance).
//
// Run: node tests/spawn.mjs

import { createJiti } from "jiti";
import { readFileSync } from "node:fs";
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

const spawn = await jiti.import(join(ROOT, "src/spawn.ts"), { parent: ROOT });
const agentsTool = await jiti.import(join(ROOT, "src/tools/agents.ts"), {
	parent: ROOT,
});
const settingsMod = await jiti.import(join(ROOT, "src/settings.ts"), {
	parent: ROOT,
});
const TINTINWEB = JSON.parse(
	readFileSync(
		join(ROOT, "tests/fixtures/tintinweb-default-agents.json"),
		"utf8",
	),
);

// fresh state between sections
function reset() {
	spawn.clearSessionAgents();
	spawn.clearSpawnRegistry();
}

// ---------------------------------------------------------------------------
console.log("\n[1] `type` xor `agent` — exactly one");
{
	reset();
	const both = spawn.resolveSpecifier({ type: "Explore", agent: { name: "x" } });
	assert(
		!both.ok && /exactly one/i.test(both.error.message),
		"both type+agent errors mentioning 'exactly one'",
	);
	const neither = spawn.resolveSpecifier({});
	assert(
		!neither.ok && /one of/i.test(neither.error.message),
		"neither errors asking for one",
	);
	const badInline = spawn.resolveSpecifier({
		agent: { name: "x", tools: ["read", 5] },
	});
	assert(
		!badInline.ok && /agent\.tools/.test(badInline.error.message),
		"inline field type error names the field",
	);
	const unknownKeys = spawn.resolveSpecifier({
		agent: { name: "x", thinking: "high", max_turns: 10 },
	});
	assert(unknownKeys.ok, "unknown inline keys ignored (cross-dialect no-ops)");
}

// ---------------------------------------------------------------------------
console.log("\n[2] Built-in trio — tintinweb content verbatim, no model pins");
{
	reset();
	const B = spawn.BUILT_IN_AGENTS;
	assert(
		eq([...B.keys()], ["general-purpose", "Explore", "Plan"]),
		"exactly the trio, in order",
	);
	for (const [key, fx] of Object.entries(TINTINWEB)) {
		const b = B.get(key);
		assert(!!b, `${key} present`);
		assert(b.name === fx.name, `${key} name verbatim`);
		assert(b.description === fx.description, `${key} description verbatim`);
		assert(b.system_prompt === fx.systemPrompt, `${key} system prompt verbatim`);
		assert(
			eq(b.tools ?? null, fx.builtinToolNames),
			`${key} tools ${fx.builtinToolNames ? "allowlist verbatim" : "= all tools (omitted)"}`,
		);
		assert(
			b.prompt_mode === fx.promptMode,
			`${key} prompt_mode ${fx.promptMode} verbatim`,
		);
		assert(b.model === undefined, `${key} carries NO model pin (inherit)`);
		assert(b.kind === "pi", `${key} kind pi`);
	}
	// the fixture proves the pin existed in tintinweb and we dropped it on purpose
	assert(
		TINTINWEB.Explore.model === "anthropic/claude-haiku-4-5",
		"fixture records tintinweb's Explore pin (deliberately dropped)",
	);
}

// ---------------------------------------------------------------------------
console.log("\n[3] Unknown `type` errors listing available types");
{
	reset();
	const r = spawn.resolveAgentType("nope");
	assert(!r.ok, "unknown type errors");
	assert(
		["general-purpose", "Explore", "Plan"].every((n) =>
			r.error.message.includes(n),
		),
		"error lists the built-in trio",
	);
	spawn.registerSessionAgent({ name: "my-inline", description: "d" });
	const r2 = spawn.resolveAgentType("nope");
	assert(
		r2.error.message.includes("my-inline"),
		"error lists session inline definitions too",
	);
	const layers = spawn.listAgentTypes().map((t) => t.name);
	assert(
		eq(layers, ["my-inline", "general-purpose", "Explore", "Plan"]),
		"listAgentTypes: session first, then built-ins",
	);
	// session shadows built-in (precedence observable today; file layers come with the .md ticket)
	spawn.registerSessionAgent({ name: "Explore", description: "shadow" });
	assert(
		spawn.resolveAgentType("Explore").data.layer === "session",
		"session layer shadows a same-name built-in",
	);
}

// ---------------------------------------------------------------------------
console.log("\n[4] `name` fallback chain → unique pane handle");
{
	reset();
	const taken = new Set(["alpha", "beta"]);
	assert(
		spawn.uniqueHandle("alpha", taken) === "alpha-2",
		"taken name falls back to -2",
	);
	taken.add("alpha-2");
	assert(spawn.uniqueHandle("alpha", taken) === "alpha-3", "chain continues -3");
	assert(spawn.uniqueHandle("gamma", taken) === "gamma", "free name untouched");
}

// ---------------------------------------------------------------------------
console.log("\n[5] kind/model merge + enforce-or-error per kind");
{
	reset();
	const gp = { name: "gp", kind: "pi" };
	// merge order: spawn param > definition > default
	const m1 = spawn.mergeSpawnSpec(gp, { kind: "claude", model: "m1" }, "pi");
	assert(m1.kind === "claude" && m1.model === "m1", "spawn params win");
	const m2 = spawn.mergeSpawnSpec(
		{ name: "d", kind: "codex", model: "dm" },
		{},
		"pi",
	);
	assert(
		m2.kind === "codex" && m2.model === "dm",
		"definition fills when param absent",
	);
	const m3 = spawn.mergeSpawnSpec({ name: "d" }, {}, "pi");
	assert(m3.kind === "pi", "settings default_kind fills the chain");
	// enforcement
	assert(
		spawn.validateKindEnforcement(m1) === null,
		"pi spec with all fields is fine",
	);
	const skillsOnClaude = spawn.mergeSpawnSpec(
		{ name: "x", skills: ["/skills/foo"] },
		{ kind: "claude" },
		"pi",
	);
	const e1 = spawn.validateKindEnforcement(skillsOnClaude);
	assert(
		!!e1 &&
			/"skills"/.test(e1.error.message) &&
			/agent_args/.test(e1.error.message),
		"claude + skills errors naming the field, pointing at agent_args",
	);
	const sysOnCodex = spawn.mergeSpawnSpec(
		{ name: "x", system_prompt: "be brief" },
		{ kind: "codex" },
		"pi",
	);
	assert(
		/spawn|system_prompt/.test(
			String(spawn.validateKindEnforcement(sysOnCodex)?.error.message),
		),
		"codex + system_prompt errors",
	);
	const modelOnCodex = spawn.mergeSpawnSpec(
		{ name: "x", model: "o3" },
		{ kind: "codex" },
		"pi",
	);
	assert(
		spawn.validateKindEnforcement(modelOnCodex) === null,
		"codex + model is allowed (verified -m flag)",
	);
	const modelOnUnknown = spawn.mergeSpawnSpec(
		{ name: "x", model: "z" },
		{ kind: "kimi" },
		"pi",
	);
	const e2 = spawn.validateKindEnforcement(modelOnUnknown);
	assert(
		!!e2 && /"model"/.test(e2.error.message),
		"unknown kind + model errors (passthrough knows no flags)",
	);
	const modelOnGemini = spawn.mergeSpawnSpec(
		{ name: "x", model: "z" },
		{ kind: "gemini" },
		"pi",
	);
	assert(
		spawn.validateKindEnforcement(modelOnGemini) === null,
		"gemini + model allowed (verified --model)",
	);
	// merged validation once: definition field + kind override must agree
	const exploreAsClaude = spawn.mergeSpawnSpec(
		spawn.resolveAgentType("Explore").data.definition,
		{ kind: "claude" },
		"pi",
	);
	assert(
		spawn.validateKindEnforcement(exploreAsClaude) === null,
		"Explore + kind claude merges cleanly (claude enforces its fields)",
	);
	const planAsCodex = spawn.mergeSpawnSpec(
		spawn.resolveAgentType("Plan").data.definition,
		{ kind: "codex" },
		"pi",
	);
	const e3 = spawn.validateKindEnforcement(planAsCodex);
	assert(
		!!e3 && e3.error.details?.field === "system_prompt",
		"Plan + kind codex errors on the MERGED spec (system_prompt)",
	);
}

// ---------------------------------------------------------------------------
console.log("\n[6] buildAgentArgs — definition → CLI flags per kind");
{
	reset();
	const explore = spawn.resolveAgentType("Explore").data.definition;
	const spec = spawn.mergeSpawnSpec(explore, {}, "pi");
	const args = spawn.buildAgentArgs(spec);
	assert(
		args[0] === "--system-prompt" && args[1] === explore.system_prompt,
		"Explore pins its read-only system prompt (replace mode)",
	);
	assert(
		args.includes("--tools") &&
			args[args.indexOf("--tools") + 1] === "read,bash,grep,find,ls",
		"Explore allowlist joins comma-separated",
	);
	const gpSpec = spawn.mergeSpawnSpec(
		spawn.resolveAgentType("general-purpose").data.definition,
		{},
		"pi",
	);
	assert(
		eq(spawn.buildAgentArgs(gpSpec), []),
		"general-purpose passes no flags (empty prompt, all tools, no model)",
	);
	const appended = spawn.mergeSpawnSpec(
		{ name: "x", system_prompt: "extra", prompt_mode: "append" },
		{},
		"pi",
	);
	assert(
		eq(spawn.buildAgentArgs(appended), ["--append-system-prompt", "extra"]),
		"prompt_mode append maps to --append-system-prompt",
	);
	const skillsSpec = spawn.mergeSpawnSpec(
		{ name: "x", skills: ["/a", "/b"], model: "m" },
		{},
		"pi",
	);
	assert(
		eq(spawn.buildAgentArgs(skillsSpec), [
			"--model",
			"m",
			"--skill",
			"/a",
			"--skill",
			"/b",
		]),
		"skills repeat --skill; model pins",
	);
	const claudeDeny = spawn.mergeSpawnSpec(
		{ name: "x", exclude_tools: ["write"] },
		{ kind: "claude" },
		"pi",
	);
	assert(
		eq(spawn.buildAgentArgs(claudeDeny), ["--disallowedTools", "write"]),
		"claude denylist maps to --disallowedTools",
	);
	const raw = spawn.mergeSpawnSpec(
		{ name: "x", agent_args: ["--continue"] },
		{ kind: "claude" },
		"pi",
	);
	assert(
		eq(spawn.buildAgentArgs(raw), ["--continue"]),
		"agent_args passthrough (raw flags last)",
	);
}

// ---------------------------------------------------------------------------
console.log("\n[6b] multiline args — temp-file carrier (pi) or honest refusal");
{
	reset();
	const writes = [];
	const deps = {
		writeFile: (p, t) => writes.push({ p, t }),
		tmpPath: (h, n) => `/tmp/${h}-${n}.md`,
	};
	const ok = spawn.materializeAgentArgs(
		["--system-prompt", "a\nb", "--tools", "read"],
		"exp",
		"pi",
		deps,
	);
	assert(
		ok.ok && eq(ok.data, ["--system-prompt", "/tmp/exp-1.md", "--tools", "read"]),
		"pi multiline prompt → temp-file path substituted in place",
	);
	assert(
		writes.length === 1 &&
			writes[0].p === "/tmp/exp-1.md" &&
			writes[0].t === "a\nb",
		"prompt file written verbatim",
	);
	const two = spawn.materializeAgentArgs(
		["--append-system-prompt", "x\n", "--append-system-prompt", "y\n"],
		"exp",
		"pi",
		deps,
	);
	assert(
		two.ok && two.data[1] === "/tmp/exp-1.md" && two.data[3] === "/tmp/exp-2.md",
		"repeatable append values get distinct files",
	);
	const claude = spawn.materializeAgentArgs(
		["--system-prompt", "a\nb"],
		"e",
		"claude",
		deps,
	);
	assert(
		!claude.ok && /claude.*no file-based/.test(claude.error.message),
		"claude multiline prompt refuses (no file flag)",
	);
	const other = spawn.materializeAgentArgs(["--model", "x\ny"], "e", "pi", deps);
	assert(
		!other.ok && /--model/.test(other.error.message),
		"non-prompt multiline value refuses naming the flag",
	);
	const single = spawn.materializeAgentArgs(
		["--system-prompt", "one line"],
		"e",
		"pi",
		deps,
	);
	assert(
		single.ok &&
			eq(single.data, ["--system-prompt", "one line"]) &&
			writes.length === 3,
		"single-line values pass through untouched",
	);
}

// ---------------------------------------------------------------------------
console.log("\n[7] Spawn depth — env counter, boundary correct");
{
	reset();
	assert(spawn.parseSpawnDepth(undefined) === 1, "unset = 1");
	assert(spawn.parseSpawnDepth("") === 1, "empty = 1");
	assert(spawn.parseSpawnDepth("3") === 3, "valid int parses");
	assert(spawn.parseSpawnDepth("garbage") === 1, "malformed = 1");
	assert(spawn.parseSpawnDepth("0") === 1, "non-positive = 1");
	const S = (over) => ({ ...settingsMod.DEFAULT_SETTINGS, ...over });
	// default max_spawn_depth = 2
	assert(
		spawn.checkGates(S({}), {}, 0).decision === "spawn",
		"root (unset=1) → child 2 ≤ max 2: allowed",
	);
	assert(
		spawn.checkGates(S({}), { PI_HERDR_SPAWN_DEPTH: "2" }, 0).decision ===
			"refuse",
		"depth 2 → child 3 > max 2: refused",
	);
	assert(
		spawn.checkGates(S({ max_spawn_depth: 1 }), {}, 0).decision === "refuse",
		"max 1 → root cannot spawn at all",
	);
	assert(
		spawn.checkGates(S({ max_spawn_depth: 3 }), { PI_HERDR_SPAWN_DEPTH: "2" }, 0)
			.decision === "spawn",
		"max 3, depth 2 → child 3: allowed",
	);
}

// ---------------------------------------------------------------------------
console.log("\n[8] Gate order — kill-switch before depth before cap");
{
	reset();
	const S = (over) => ({ ...settingsMod.DEFAULT_SETTINGS, ...over });
	const allBad = S({
		agents_kill_switch: true,
		max_spawn_depth: 1, // depth would refuse too
		max_parallel_agents: 1, // cap would queue too
	});
	const r1 = spawn.checkGates(allBad, { PI_HERDR_SPAWN_DEPTH: "1" }, 5);
	assert(
		r1.decision === "refuse" && /kill_switch/.test(r1.error.message),
		"kill-switch wins when all three gates trip",
	);
	const depthAndCap = S({ max_spawn_depth: 1, max_parallel_agents: 1 });
	const r2 = spawn.checkGates(depthAndCap, { PI_HERDR_SPAWN_DEPTH: "1" }, 5);
	assert(
		r2.decision === "refuse" && /spawn depth/.test(r2.error.message),
		"depth wins over cap",
	);
	const capOnly = S({ max_parallel_agents: 1 });
	const r3 = spawn.checkGates(capOnly, {}, 1);
	assert(r3.decision === "queue", "cap alone queues (accepted, not refused)");
	const clear = spawn.checkGates(S({}), {}, 0);
	assert(clear.decision === "spawn", "all clear spawns");
}

// ---------------------------------------------------------------------------
// Engine harness: every herdr-facing seam injected; autodrain off so queue
// tests drive drains explicitly (no timers, no wall-clock dependence).
function makeDeps(opts = {}) {
	const calls = { start: [], submit: [], worktree: [] };
	const live = opts.live ?? []; // [{name, paneId, agent_status}]
	return {
		calls,
		live,
		deps: {
			load: () => ({ ...settingsMod.DEFAULT_SETTINGS, ...opts.settings }),
			kinds: async () => opts.kinds ?? ["pi", "claude", "codex", "gemini"],
			list: async () =>
				live
					.filter((a) => a.paneId)
					.map((a) => ({ name: a.name, paneId: a.paneId })),
			start: async (input) => {
				calls.start.push(input);
				const paneId = `p${calls.start.length}`;
				live.push({ name: input.name, paneId, agent_status: "idle" });
				return { ok: true, data: { agent: { pane_id: paneId } } };
			},
			boot: async () => ({ ok: true, data: true }),
			submit: async (paneId, text) => {
				calls.submit.push({ paneId, text });
				const a = live.find((x) => x.paneId === paneId);
				if (a) a.agent_status = "working";
				return { ok: true, data: true };
			},
			status: async (paneId) => {
				const a = live.find((x) => x.paneId === paneId);
				return a
					? { ok: true, data: a.agent_status }
					: { ok: false, error: { code: "NOT_FOUND", message: "agent gone" } };
			},
			worktree: async (cwd) => {
				calls.worktree.push(cwd);
				return { ok: true, data: "D:/wt/auto-branch" };
			},
			env: opts.env ?? {},
			autodrain: false,
		},
	};
}

// ---------------------------------------------------------------------------
console.log("\n[9] Engine — background spawn end to end, child env stamped");
{
	reset();
	const h = makeDeps({ env: { HERDR_PANE_ID: "w9:p9" } });
	const r = await spawn.spawnAgent(
		{ prompt: "find the entry point", type: "Explore", name: "scout" },
		h.deps,
	);
	assert(r.ok, `spawn ok (${r.ok ? "" : r.error.message})`);
	assert(r.data.status === "working", "right after submit: working");
	assert(r.data.paneId === "p1", "paneId returned");
	assert(r.data.name === "scout", "explicit name is the handle");
	assert(r.data.type === "Explore", "definition type reported");
	assert(r.data.depth === 2, "child depth = root(1) + 1");
	const start = h.calls.start[0];
	assert(start.env.PI_HERDR_SPAWN_DEPTH === "2", "child env: incremented depth");
	assert(
		start.env.PI_HERDR_ORCHESTRATOR_PANE === "w9:p9",
		"child env: orchestrator pane from HERDR_PANE_ID",
	);
	assert(
		start.agentArgs[0] === "--system-prompt",
		"Explore's read-only prompt passed to the child CLI",
	);
	assert(
		h.calls.submit[0].text === "find the entry point",
		"prompt submitted to the pane",
	);
	// no HERDR_PANE_ID → no orchestrator var
	const h2 = makeDeps();
	await spawn.spawnAgent({ prompt: "x", type: "Plan", name: "quiet" }, h2.deps);
	assert(
		h2.calls.start[0].env.PI_HERDR_ORCHESTRATOR_PANE === undefined,
		"no HERDR_PANE_ID → orchestrator var omitted",
	);
	// kill-switched settings refuse before any start
	const h3 = makeDeps({ settings: { agents_kill_switch: true } });
	const r3 = await spawn.spawnAgent({ prompt: "x", type: "Plan" }, h3.deps);
	assert(
		!r3.ok && r3.error.code === "SPAWN_REFUSED" && h3.calls.start.length === 0,
		"kill-switch refuses with zero pane side effects",
	);
	// deep session refuses
	const h4 = makeDeps({ env: { PI_HERDR_SPAWN_DEPTH: "2" } });
	const r4 = await spawn.spawnAgent({ prompt: "x", type: "Plan" }, h4.deps);
	assert(
		!r4.ok && /spawn depth/.test(r4.error.message) && h4.calls.start.length === 0,
		"depth-2 session refused at max_spawn_depth 2",
	);
	// unknown kind: general-purpose sets no enforced fields, so the kind itself
	// fails against the (injected) live kind list
	const h5 = makeDeps();
	const r5 = await spawn.spawnAgent(
		{ prompt: "x", type: "general-purpose", kind: "bogus" },
		h5.deps,
	);
	assert(
		!r5.ok && /Unknown agent kind/.test(r5.error.message),
		"unknown kind errors against the kind list",
	);
}

// ---------------------------------------------------------------------------
console.log("\n[10] Inline definitions spawn and register session-ephemerally");
{
	reset();
	const h = makeDeps();
	const r = await spawn.spawnAgent(
		{
			prompt: "audit deps",
			agent: {
				name: "dep-auditor",
				kind: "pi",
				system_prompt: "You audit dependencies.",
				tools: ["read", "bash"],
			},
			name: "audit-1",
		},
		h.deps,
	);
	assert(
		r.ok && r.data.type === "dep-auditor",
		"inline spawn ok, type = its name",
	);
	assert(
		h.calls.start[0].agentArgs.includes("You audit dependencies."),
		"inline system_prompt reached the child CLI",
	);
	assert(
		spawn
			.listAgentTypes()
			.some((t) => t.name === "dep-auditor" && t.layer === "session"),
		"inline definition registered session-ephemerally",
	);
	const h2 = makeDeps();
	const r2 = await spawn.spawnAgent(
		{ prompt: "again", type: "dep-auditor", name: "audit-2" },
		h2.deps,
	);
	assert(
		r2.ok && r2.data.type === "dep-auditor",
		"later spawn resolves the inline definition via `type`",
	);
	const h3 = makeDeps();
	const r3 = await spawn.spawnAgent(
		{ prompt: "x", agent: { system_prompt: "" } },
		h3.deps,
	);
	assert(
		r3.ok && /^agent-\d+$/.test(r3.data.name),
		"anonymous inline gets agent-<timestamp>",
	);
	assert(
		!spawn.listAgentTypes().some((t) => t.name === ""),
		"anonymous inline is NOT registered (no name to address)",
	);
}

// ---------------------------------------------------------------------------
console.log(
	"\n[11] Name chain through the engine (param → def → auto, uniquified)",
);
{
	reset();
	const h = makeDeps();
	const a = await spawn.spawnAgent({ prompt: "x", type: "Explore" }, h.deps);
	assert(
		a.data.name === "Explore",
		"no param, no inline name → definition name",
	);
	const b = await spawn.spawnAgent({ prompt: "x", type: "Explore" }, h.deps);
	assert(b.data.name === "Explore-2", "taken definition name falls back -2");
	const c = await spawn.spawnAgent(
		{ prompt: "x", type: "Explore", name: "probe" },
		h.deps,
	);
	assert(c.data.name === "probe", "explicit param wins");
	const d = await spawn.spawnAgent(
		{ prompt: "x", type: "Explore", name: "probe" },
		h.deps,
	);
	assert(d.data.name === "probe-2", "taken explicit name falls back -2");
}

// ---------------------------------------------------------------------------
console.log("\n[12] Over-cap spawn queues; pane appears when a slot frees");
{
	reset();
	const h = makeDeps({ settings: { max_parallel_agents: 1 } });
	const a = await spawn.spawnAgent(
		{ prompt: "x", type: "Plan", name: "first" },
		h.deps,
	);
	assert(a.ok && a.data.paneId === "p1", "cap 1: first spawn starts");
	const b = await spawn.spawnAgent(
		{ prompt: "y", type: "Plan", name: "second" },
		h.deps,
	);
	assert(
		b.ok &&
			b.data.status === "queued" &&
			!b.data.paneId &&
			b.data.queued === true,
		"over-cap spawn accepted as queued with no pane",
	);
	assert(h.calls.start.length === 1, "queued record created no pane");
	// bounded wait on a queued record returns the current (queued) state
	const bWait = await spawn.spawnAgent(
		{ prompt: "z", type: "Plan", name: "third", wait: 0 },
		h.deps,
	);
	assert(
		bWait.ok && bWait.data.status === "queued" && bWait.data.waited === true,
		"wait: ms on a queued spawn returns queued on expiry",
	);
	// a slot frees: first pane leaves the fleet
	h.live.splice(0, h.live.findIndex((x) => x.name === "first") + 1);
	const started = await spawn.drainQueueOnce(h.deps);
	assert(started === 1, "drain starts one queued record");
	const rec = spawn.spawnRecords().get("second");
	assert(!!rec?.paneId, "queued record now has a pane");
	const rec3 = spawn.spawnRecords().get("third");
	assert(!rec3?.paneId, "the third stays queued (cap still held)");
	// hand-spawned fleet panes never hold a session slot (watch-scope decision)
	const h2 = makeDeps({
		settings: { max_parallel_agents: 1 },
		live: [{ name: "human-pane", paneId: "px" }],
	});
	const r2 = await spawn.spawnAgent(
		{ prompt: "x", type: "Plan", name: "next-to-human" },
		h2.deps,
	);
	assert(
		r2.ok && r2.data.paneId !== undefined,
		"a hand-spawned pane in the fleet does not queue the session's spawn",
	);
}

// ---------------------------------------------------------------------------
console.log(
	"\n[13] `wait` vocabulary (deterministic — fakes settle instantly)",
);
{
	reset();
	// wait: true → done when the pane settles idle right after submission
	const h2 = makeDeps();
	h2.deps.submit = async (paneId, text) => {
		h2.calls.submit.push({ paneId, text });
		h2.live[0].agent_status = "idle";
		return { ok: true, data: true };
	};
	const r2 = await spawn.spawnAgent(
		{ prompt: "x", type: "Plan", name: "w2", wait: true },
		h2.deps,
	);
	assert(
		r2.ok && r2.data.status === "done" && r2.data.waited === true,
		"wait: true returns done on settle",
	);
	// blocked is terminal for wait: true
	const h3 = makeDeps();
	h3.deps.status = async () => ({ ok: true, data: "blocked" });
	const r3 = await spawn.spawnAgent(
		{ prompt: "x", type: "Plan", name: "w3", wait: true },
		h3.deps,
	);
	assert(r3.ok && r3.data.status === "blocked", "wait: true returns on blocked");
	// wait: 0 → immediate expiry returns the CURRENT state (working)
	const h4 = makeDeps();
	const r4 = await spawn.spawnAgent(
		{ prompt: "x", type: "Plan", name: "w4", wait: 0 },
		h4.deps,
	);
	assert(
		r4.ok && r4.data.status === "working" && r4.data.waited === true,
		"wait: ms returns working on expiry",
	);
	// default: no wait, returns immediately
	const h5 = makeDeps();
	const r5 = await spawn.spawnAgent(
		{ prompt: "x", type: "Plan", name: "w5" },
		h5.deps,
	);
	assert(
		r5.ok && r5.data.waited === undefined && r5.data.status === "working",
		"default returns immediately (background)",
	);
}

// ---------------------------------------------------------------------------
console.log("\n[14] isolated: true — herdr-side worktree");
{
	reset();
	const h = makeDeps();
	const r = await spawn.spawnAgent(
		{ prompt: "x", type: "general-purpose", name: "iso", isolated: true },
		h.deps,
	);
	assert(
		r.ok && r.data.worktreePath === "D:/wt/auto-branch",
		"worktree path returned",
	);
	assert(h.calls.worktree.length === 1, "worktree create called once");
	assert(
		h.calls.start[0].cwd === "D:/wt/auto-branch",
		"child cwd = worktree path",
	);
	const h2 = makeDeps();
	const r2 = await spawn.spawnAgent(
		{ prompt: "x", type: "Plan", isolated: true, cwd: "D:/elsewhere" },
		h2.deps,
	);
	assert(
		!r2.ok && /mutually exclusive/i.test(r2.error.message),
		"isolated + cwd errors (no silent surprise)",
	);
}

// ---------------------------------------------------------------------------
console.log(
	"\n[15] Failure honesty — start/boot/submit errors carry the handle",
);
{
	reset();
	const h = makeDeps();
	h.deps.start = async () => ({
		ok: false,
		error: { code: "AGENT_START_FAILED", message: "boom" },
	});
	const r = await spawn.spawnAgent(
		{ prompt: "x", type: "Plan", name: "doomed" },
		h.deps,
	);
	assert(
		!r.ok && r.error.details?.name === "doomed",
		"start failure names the handle",
	);
	const h2 = makeDeps();
	h2.deps.boot = async () => ({
		ok: false,
		error: { code: "TIMEOUT", message: "never idle" },
	});
	const r2 = await spawn.spawnAgent(
		{ prompt: "x", type: "Plan", name: "slowboot" },
		h2.deps,
	);
	assert(
		!r2.ok && r2.error.details?.paneId === "p1",
		"boot failure reports the pane id (pane exists)",
	);
	// lost prompt (NOT_STARTED) is retried once
	const h3 = makeDeps();
	let n = 0;
	h3.deps.submit = async (paneId, text) => {
		h3.calls.submit.push({ paneId, text });
		n++;
		if (n === 1)
			return { ok: false, error: { code: "TIMEOUT", message: "NOT_STARTED" } };
		h3.live[0].agent_status = "working";
		return { ok: true, data: true };
	};
	const r3 = await spawn.spawnAgent(
		{ prompt: "x", type: "Plan", name: "retry" },
		h3.deps,
	);
	assert(r3.ok && h3.calls.submit.length === 2, "NOT_STARTED is retried once");
}

// ---------------------------------------------------------------------------
console.log("\n[16] Tool registration surface");
{
	reset();
	const tools = [];
	const mockPi = { registerTool: (d) => tools.push(d), on: () => {} };
	agentsTool.registerAgents(mockPi);
	const t = tools.find((x) => x.name === "herdr_spawn_agent");
	assert(!!t, "herdr_spawn_agent registered");
	assert(
		t.description.includes("Fast read-only search agent") &&
			t.description.includes("Software architect agent") &&
			t.description.includes("General-purpose agent for researching"),
		"description carries the trio's full text",
	);
	// offline-safe error path: specifier failure happens before any I/O
	const res = await t.execute("t1", { prompt: "x" }, undefined);
	assert(
		res.isError === true && /one of/.test(res.content[0].text),
		"execute without type/agent errors cleanly",
	);
}

// ---------------------------------------------------------------------------
console.log(
	`\n${failed === 0 ? "✅ ALL PASS" : "❌ SOME FAILED"} (${passed}/${passed + failed})`,
);
process.exit(failed === 0 ? 0 : 1);
