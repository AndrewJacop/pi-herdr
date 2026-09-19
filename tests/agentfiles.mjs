// Tests for the `.md` agent registry (v0.6 issue 03): the frontmatter
// dialect (full v0.6 field set parses, validates, round-trips), precedence
// (session > project > global > built-in, first-hit-wins, project shadows
// global), malformed files reported honestly without killing the rest,
// unknown keys ignored (the shared-folder rule), saveAgent (project/global
// target, overwrite guard, save → reload → spawn by type), and the spawn
// integration (agentDirs seam, frontmatter args → agentArgs, definition cwd).
//
// No live herdr required: herdr-facing seams are injected (copied from
// tests/spawn.mjs's fakes) and every file layer runs in mkdtemp dirs.
//
// agentdefs APIs are consumed through src/spawn.ts's re-exports — the session
// registry is mutable module state and must have ONE jiti instance here.
//
// Run: node tests/agentfiles.mjs

import { createJiti } from "jiti";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
/** Order-insensitive deep equality (key order never matters for definitions). */
function canon(v) {
	if (Array.isArray(v)) return v.map(canon);
	if (v && typeof v === "object") {
		return Object.fromEntries(
			Object.keys(v)
				.sort()
				.map((k) => [k, canon(v[k])]),
		);
	}
	return v;
}
function jeq(a, b) {
	return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}

const spawn = await jiti.import(join(ROOT, "src/spawn.ts"), { parent: ROOT });
const agentsTool = await jiti.import(join(ROOT, "src/tools/agents.ts"), {
	parent: ROOT,
});

// fresh temp registry dirs + state between sections
const dirsStack = [];
function reset() {
	spawn.clearSessionAgents();
	spawn.clearSpawnRegistry();
}
function tempDirs() {
	const project = mkdtempSync(join(tmpdir(), "pi-herdr-agents-p-"));
	const global = mkdtempSync(join(tmpdir(), "pi-herdr-agents-g-"));
	dirsStack.push(project, global);
	return { project, global };
}
process.on("exit", () => {
	for (const d of dirsStack) {
		try {
			rmSync(d, { recursive: true, force: true });
		} catch {
			/* best-effort */
		}
	}
});
function write(dir, file, content) {
	writeFileSync(join(dir, file), content, "utf8");
}

// a definition exercising EVERY v0.6 frontmatter field
const FULL_DEF = {
	name: " auditor ",
	description: 'Audit: "strict", colons: yes — trailing space ',
	kind: "pi",
	model: "anthropic/claude-opus-4-6",
	thinking: "high",
	session_mode: "fork",
	auto_exit: true,
	interactive: false,
	spawning: false,
	tools: ["read", "bash"],
	exclude_tools: ["write", "edit"],
	skills: ["/skills/audit"],
	agent_args: ["--plan", "--tools", "a,b"],
	cwd: "D:/tmp/audit",
	prompt_mode: "append",
	system_prompt: "You audit things.\nBe thorough.",
};

// ---------------------------------------------------------------------------
console.log("\n[1] parse — the full v0.6 field set, hand-written dialect");
{
	reset();
	const md =
		"---\n" +
		"name: auditor\n" +
		'description: "Audit: \\"strict\\", colons: yes — trailing space "\n' +
		"kind: pi\n" +
		"model: anthropic/claude-opus-4-6\n" +
		"thinking: high\n" +
		"session-mode: fork\n" +
		"auto-exit: true\n" +
		"interactive: false\n" +
		"spawning: false\n" +
		"tools: read, bash\n" + // prior-art comma list
		'deny-tools: ["write", "edit"]\n' + // our JSON-array form
		"skills: /skills/audit\n" +
		'args: ["--plan", "--tools", "a,b"]\n' +
		"cwd: D:/tmp/audit\n" +
		"prompt_mode: append\n" +
		"---\n\n" +
		"You audit things.\nBe thorough.\n";
	const r = spawn.parseAgentMarkdown(md, "fallback");
	assert(r.ok, `parses (${r.ok ? "" : r.error.message})`);
	const d = r.data;
	const want = { ...FULL_DEF, name: "auditor" };
	assert(jeq(d, want), "every field lands on the definition contract");
	assert(
		d.system_prompt === "You audit things.\nBe thorough.",
		"body = system_prompt",
	);
	assert(d.exclude_tools.join() === "write,edit", "deny-tools → exclude_tools");
	assert(
		eq(d.agent_args, ["--plan", "--tools", "a,b"]),
		"args → agent_args (commas inside values survive)",
	);
}

// ---------------------------------------------------------------------------
console.log("\n[2] unknown keys ignored — the shared-folder rule");
{
	reset();
	const md =
		"---\n" +
		"name: scout\n" +
		"description: Fast recon\n" +
		"cli: some-cli\n" +
		"command: run-it.sh\n" +
		"command-template: {{cmd}}\n" +
		"system-prompt: append\n" +
		"skill: chrome-cdp\n" +
		"output: context.md\n" +
		"disable-model-invocation: true\n" +
		"max-turns: 40\n" +
		"---\n\nGo scout.\n";
	const r = spawn.parseAgentMarkdown(md, "scout");
	assert(r.ok, "prior-art + foreign keys never break the parse");
	assert(
		r.data.name === "scout" && r.data.description === "Fast recon",
		"known keys still land",
	);
	assert(
		r.data.prompt_mode === undefined,
		"their `system-prompt` key is theirs — ignored, not aliased",
	);
	assert(
		r.data.skills === undefined,
		"their `skill:` (singular) ignored — our key is `skills`",
	);
	assert(
		r.data.agent_args === undefined && r.data.auto_exit === undefined,
		"no phantom fields",
	);
}

// ---------------------------------------------------------------------------
console.log("\n[3] honest validation — known-but-wrong names the field");
{
	reset();
	const bad = (fm) =>
		spawn.parseAgentMarkdown(`---\nname: x\n${fm}\n---\n\nbody\n`, "x");
	let r = bad("auto-exit: banana");
	assert(
		!r.ok && /auto_exit must be true or false/.test(r.error.message),
		"bad bool names agent.auto_exit",
	);
	r = bad("session-mode: telepathic");
	assert(
		!r.ok && /session_mode/.test(r.error.message),
		"bad session-mode names the field",
	);
	r = bad("prompt_mode: sideways");
	assert(
		!r.ok && /prompt_mode/.test(r.error.message),
		"bad prompt_mode names the field",
	);
	r = bad("tools: [oops");
	assert(
		!r.ok && /tools/.test(r.error.message),
		"malformed array names the field",
	);
	r = bad('args: ["--x", 5]');
	assert(
		!r.ok && /args/.test(r.error.message),
		"non-string array member names the field",
	);
	r = bad('description: "bad " inner"');
	assert(
		!r.ok && /malformed double-quoted/.test(r.error.message),
		"malformed quoted scalar reported",
	);
	r = spawn.parseAgentMarkdown("no frontmatter here at all", "x");
	assert(
		!r.ok && /frontmatter/.test(r.error.message),
		"frontmatter-less file errors honestly",
	);
	// forgiving-by-design forms
	r = bad("description:");
	assert(r.ok && r.data.description === undefined, "empty scalar ≡ absent");
	r = bad("tools:");
	assert(r.ok && r.data.tools === undefined, "empty list ≡ absent");
	r = spawn.parseAgentMarkdown("---\n---\n\nJust a body.\n", "nameless");
	assert(
		r.ok && r.data.name === "nameless",
		"no `name` key → filename fallback",
	);
	// nested YAML from foreign dialects is ignored, not fatal
	r = spawn.parseAgentMarkdown(
		"---\nname: nested\ntools:\n  - write\n  - edit\n---\n\nbody\n",
		"nested",
	);
	assert(
		r.ok && r.data.tools === undefined,
		"indented block-list lines ignored as foreign YAML",
	);
	// a Windows-authored BOM file still parses
	r = spawn.parseAgentMarkdown("\uFEFF---\nname: bommy\n---\n\nB\n", "bommy");
	assert(
		r.ok && r.data.name === "bommy",
		"UTF-8 BOM stripped before the frontmatter match",
	);
	// CRLF files parse too
	r = spawn.parseAgentMarkdown(
		"---\r\nname: crlf\r\nauto-exit: true\r\n---\r\n\r\nB\r\n",
		"crlf",
	);
	assert(
		r.ok && r.data.name === "crlf" && r.data.auto_exit === true,
		"CRLF frontmatter parses",
	);
}

// ---------------------------------------------------------------------------
console.log("\n[4] format → parse round-trip");
{
	reset();
	const fmt = spawn.formatAgentMarkdown(FULL_DEF);
	assert(fmt.ok, "formats");
	const back = spawn.parseAgentMarkdown(fmt.data, "irrelevant");
	assert(back.ok, `re-parses (${back.ok ? "" : back.error.message})`);
	assert(
		jeq(back.data, FULL_DEF),
		"save→reload round-trip is value-exact (name verbatim, spaces included)",
	);
	// JSON-quoted description survives quotes/colons/trailing space
	assert(
		back.data.description === FULL_DEF.description,
		"tricky scalar round-trips byte-exact",
	);
	assert(
		fmt.data.includes('args: ["--plan","--tools","a,b"]') ||
			fmt.data.includes('args: ["--plan", "--tools", "a,b"]'),
		"writer emits a JSON array for args",
	);
	// a minimal def
	const min = spawn.formatAgentMarkdown({
		name: "mini",
		system_prompt: "Be brief.",
	});
	const minBack = spawn.parseAgentMarkdown(min.data, "x");
	assert(
		minBack.ok && jeq(minBack.data, { name: "mini", system_prompt: "Be brief." }),
		"minimal def round-trips (body present, no phantom fields)",
	);
	const empty = spawn.formatAgentMarkdown({ name: "empty" });
	const emptyBack = spawn.parseAgentMarkdown(empty.data, "x");
	assert(
		emptyBack.ok && jeq(emptyBack.data, { name: "empty" }),
		"no system prompt → no body, no phantom system_prompt",
	);
}

// ---------------------------------------------------------------------------
console.log("\n[5] format refuses what the dialect cannot carry");
{
	reset();
	const r = spawn.formatAgentMarkdown({
		name: "x",
		description: "line one\nline two",
	});
	assert(
		!r.ok && /description/.test(r.error.message),
		"newline in a scalar refuses naming the field",
	);
}

// ---------------------------------------------------------------------------
console.log("\n[6] loadFileAgents — precedence, first-hit, malformed files");
{
	reset();
	const dirs = tempDirs();
	write(
		dirs.global,
		"shared.md",
		"---\nname: shared\ndescription: from global\n---\n\nG\n",
	);
	write(
		dirs.project,
		"shared.md",
		"---\nname: shared\ndescription: from project\n---\n\nP\n",
	);
	write(
		dirs.global,
		"only-global.md",
		"---\nname: only-global\ndescription: g\n---\n\nG\n",
	);
	write(
		dirs.project,
		"aa-first.md",
		"---\nname: dupe\ndescription: first file wins\n---\n\nA\n",
	);
	write(
		dirs.project,
		"zz-second.md",
		"---\nname: dupe\ndescription: second file loses\n---\n\nB\n",
	);
	write(
		dirs.project,
		"broken.md",
		"---\nname: broken\nauto-exit: banana\n---\n\nX\n",
	);
	write(dirs.project, "notfm.md", "just some markdown, no frontmatter");
	const loaded = spawn.loadFileAgents(dirs);
	assert(
		loaded.entries.get("shared").layer === "project",
		"project shadows global (first-hit-wins)",
	);
	assert(
		loaded.entries.get("shared").definition.description === "from project",
		"shadow serves the project content",
	);
	assert(
		loaded.entries.get("only-global").layer === "global",
		"global-only name still resolves",
	);
	assert(
		loaded.entries.get("dupe").definition.description === "first file wins",
		"within a dir, first file claiming a name wins (stable order)",
	);
	assert(
		!loaded.entries.has("broken") && !loaded.entries.has("notfm"),
		"malformed files contribute nothing",
	);
	assert(
		loaded.issues.length === 2 &&
			loaded.issues.some(
				(i) => i.path.endsWith("broken.md") && /auto_exit/.test(i.problem),
			) &&
			loaded.issues.some(
				(i) => i.path.endsWith("notfm.md") && /frontmatter/.test(i.problem),
			),
		"both malformed files reported with path + problem",
	);
	const empty = spawn.loadFileAgents({
		project: join(dirs.project, "missing"),
		global: join(dirs.global, "missing"),
	});
	assert(
		empty.entries.size === 0 && empty.issues.length === 0,
		"absent dirs are normal, not issues",
	);
}

// ---------------------------------------------------------------------------
console.log("\n[7] resolveAgentType — session > project > global > built-in");
{
	reset();
	const dirs = tempDirs();
	write(
		dirs.project,
		"explore.md",
		"---\nname: Explore\ndescription: shadow of the built-in\n---\n\nP\n",
	);
	write(
		dirs.global,
		"plan.md",
		"---\nname: Plan\ndescription: global file\n---\n\nG\n",
	);
	write(dirs.project, "bad.md", "---\nname: bad\nspawning: maybe\n---\n\nX\n");
	let r = spawn.resolveAgentType("Explore", dirs);
	assert(
		r.ok && r.data.layer === "project",
		"project file shadows the built-in",
	);
	r = spawn.resolveAgentType("Plan", dirs);
	assert(
		r.ok && r.data.layer === "global",
		"global file serves when no project file",
	);
	r = spawn.resolveAgentType("general-purpose", dirs);
	assert(r.ok && r.data.layer === "built-in", "built-ins still resolve");
	spawn.registerSessionAgent({ name: "Explore", description: "session shadow" });
	r = spawn.resolveAgentType("Explore", dirs);
	assert(r.ok && r.data.layer === "session", "session shadows files");
	spawn.clearSessionAgents();
	const miss = spawn.resolveAgentType("nope", dirs);
	assert(
		!miss.ok && /Unknown agent type/.test(miss.error.message),
		"unknown type errors",
	);
	assert(
		/Explore/.test(miss.error.message) && /Plan/.test(miss.error.message),
		"error lists file-layer names",
	);
	assert(
		/bad\.md.*spawning/.test(miss.error.message),
		"error notes the skipped malformed file (honest reporting)",
	);
	const layers = spawn.listAgentTypes(dirs).map((t) => `${t.name}:${t.layer}`);
	assert(
		layers[0] === "Explore:project" &&
			layers[1] === "Plan:global" &&
			layers.includes("general-purpose:built-in") &&
			layers.includes("Explore:built-in") &&
			!layers.includes("bad:project"),
		"listAgentTypes: project, global, built-in order; malformed absent",
	);
}

// ---------------------------------------------------------------------------
console.log("\n[8] saveAgent — targets, guards, save → reload");
{
	reset();
	const dirs = tempDirs();
	// inline → project (default)
	const r = spawn.saveAgent(
		{
			agent: {
				name: "auditor",
				description: "Audits things",
				tools: ["read"],
				agent_args: ["--plan"],
			},
		},
		dirs,
	);
	assert(
		r.ok && r.data.target === "project",
		"inline definition saves to project by default",
	);
	assert(
		r.data.path === join(dirs.project, "auditor.md"),
		"file named from the agent name",
	);
	const reloaded = spawn.loadFileAgents(dirs);
	assert(
		reloaded.entries.has("auditor") &&
			eq(reloaded.entries.get("auditor").definition.tools, ["read"]),
		"a fresh load resolves the saved file",
	);
	// overwrite guard
	const again = spawn.saveAgent(
		{ agent: { name: "auditor", description: "v2" } },
		dirs,
	);
	assert(
		!again.ok && /overwrite/.test(again.error.message),
		"existing file refuses without overwrite",
	);
	const forced = spawn.saveAgent(
		{ agent: { name: "auditor", description: "v2" } },
		dirs,
	);
	assert(!forced.ok, "still refuses (guard is not sticky state)");
	const ok2 = spawn.saveAgent(
		{ agent: { name: "auditor", description: "v2" }, overwrite: true },
		dirs,
	);
	assert(ok2.ok, "overwrite: true replaces");
	assert(
		spawn.loadFileAgents(dirs).entries.get("auditor").definition.description ===
			"v2",
		"replacement is what resolves afterwards",
	);
	// session-ephemeral entry by type → global
	spawn.registerSessionAgent({
		name: "ephemeral reviewer",
		description: "born inline this session",
		auto_exit: true,
	});
	const g = spawn.saveAgent(
		{ type: "ephemeral reviewer", target: "global" },
		dirs,
	);
	assert(g.ok && g.data.target === "global", "session entry persists by type");
	assert(
		g.data.path === join(dirs.global, "ephemeral-reviewer.md"),
		"name slugified for the file name",
	);
	const gl = spawn.loadFileAgents(dirs);
	assert(
		gl.entries.get("ephemeral reviewer").definition.name ===
			"ephemeral reviewer" &&
			gl.entries.get("ephemeral reviewer").definition.auto_exit === true,
		"registry name (not the slug) addresses it after reload",
	);
	// built-in copy — saving by `type` does NOT register session-ephemerally
	// (only accepted inline spawns do); the file itself is the artifact
	const b = spawn.saveAgent({ type: "Explore", target: "project" }, dirs);
	assert(
		b.ok && b.data.path.endsWith("Explore.md"),
		"saving a built-in copy works",
	);
	assert(
		spawn.resolveAgentType("Explore", dirs).data.layer === "project",
		"the saved copy shadows the built-in from the file layer immediately",
	);
	// refusals
	const anon = spawn.saveAgent({ agent: { description: "no name" } }, dirs);
	assert(
		!anon.ok && /name/.test(anon.error.message),
		"anonymous inline definition refuses",
	);
	const both = spawn.saveAgent({ type: "Explore", agent: { name: "x" } }, dirs);
	assert(
		!both.ok && /exactly one/i.test(both.error.message),
		"type xor agent enforced on save too",
	);
}

// ---------------------------------------------------------------------------
console.log(
	"\n[9] spawn integration — file types, frontmatter args, definition cwd",
);
{
	reset();
	const dirs = tempDirs();
	write(
		dirs.project,
		"planner.md",
		[
			"---",
			"name: planner",
			"description: Plan first",
			"model: some/model-id",
			'args: ["--plan"]',
			"cwd: D:/tmp/plans",
			"---",
			"",
			"You plan things.",
			"",
		].join("\n"),
	);
	const starts = [];
	const deps = {
		agentDirs: dirs,
		autodrain: true,
		load: () => ({
			agents_kill_switch: false,
			default_kind: "pi",
			models: { default: "", agents: {} },
			max_parallel_agents: 3,
			max_spawn_depth: 2,
			notifications: "normal",
			idle_rearm_minutes: 15,
			workflows_enabled: true,
		}),
		kinds: async () => ["pi"],
		list: async () => [],
		start: async (input) => {
			starts.push(input);
			return { ok: true, data: { agent: { pane_id: "w1:p9", name: input.name } } };
		},
		boot: async () => ({ ok: true, data: true }),
		submit: async () => ({ ok: true, data: true }),
		status: async () => ({ ok: true, data: "working" }),
		env: { PI_HERDR_SPAWN_DEPTH: "1" },
	};
	const r = await spawn.spawnAgent({ prompt: "plan it", type: "planner" }, deps);
	assert(
		r.ok,
		`spawn by file-layer type works (${r.ok ? "" : r.error.message})`,
	);
	assert(
		r.data.type === "planner" && r.data.kind === "pi",
		"record carries type + kind",
	);
	assert(starts.length === 1, "exactly one pane start");
	assert(
		starts[0].agentArgs.includes("--system-prompt") &&
			starts[0].agentArgs.includes("You plan things.") &&
			starts[0].agentArgs.includes("--model") &&
			starts[0].agentArgs.includes("some/model-id"),
		"frontmatter model + body system prompt reach the argv",
	);
	assert(
		starts[0].agentArgs.includes("--plan"),
		"frontmatter args reach agentArgs (appended last)",
	);
	assert(
		starts[0].cwd === "D:/tmp/plans",
		"frontmatter cwd reaches the pane start",
	);
	// spawn-level cwd overrides the definition's
	const r2 = await spawn.spawnAgent(
		{ prompt: "plan it", type: "planner", cwd: "D:/elsewhere" },
		deps,
	);
	assert(
		r2.ok && starts[1].cwd === "D:/elsewhere",
		"spawn cwd overrides definition cwd",
	);
	// unknown type from the file layer errors listing what IS there
	const miss = await spawn.spawnAgent({ prompt: "x", type: "ghost" }, deps);
	assert(
		!miss.ok && /planner/.test(miss.error.message),
		"unknown type error lists file-layer names",
	);
}

// ---------------------------------------------------------------------------
console.log("\n[10] tool registration — herdr_save_agent");
{
	reset();
	const tools = [];
	await agentsTool.registerAgents({
		registerTool: (def) => tools.push(def),
	});
	const t = tools.find((x) => x.name === "herdr_save_agent");
	assert(!!t, "herdr_save_agent registered");
	// offline-safe paths: both specifier forms validate before any I/O
	let res = await t.execute("t1", {}, undefined);
	assert(
		res.isError === true && /one of/i.test(res.content[0].text),
		"neither type nor agent errors",
	);
	res = await t.execute("t2", { type: "ghost-type" }, undefined);
	assert(
		res.isError === true && /Unknown agent type/.test(res.content[0].text),
		"unknown type errors before writing anything",
	);
}

// ---------------------------------------------------------------------------
console.log(
	`\n${failed === 0 ? "✅ ALL PASS" : "❌ SOME FAILED"} (${passed}/${passed + failed})`,
);
process.exit(failed === 0 ? 0 : 1);
