// Tests for the settings layer (src/settings.ts) and the /herdr menu
// (src/menu.ts) — issue 01: deep merge + per-key source, the flat menu,
// persistence, restart-required surface row, kill-switch-is-a-gate-only.
//
// No live herdr server required: the menu's herdr/kinds seams are injected.
//
// Run: node tests/settings.mjs

import { createJiti } from "jiti";
import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
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
function readJson(p) {
	return JSON.parse(readFileSync(p, "utf8"));
}

const settings = await jiti.import(join(ROOT, "src/settings.ts"), {
	parent: ROOT,
});
const menu = await jiti.import(join(ROOT, "src/menu.ts"), { parent: ROOT });

const tmp = mkdtempSync(join(tmpdir(), "pi-herdr-settings-"));
const pathsFor = (name) => ({
	globalPath: join(tmp, name, "global", "herdr.json"),
	projectPath: join(tmp, name, "proj", ".pi", "herdr.json"),
});
function writeFile(p, text) {
	mkdirSync(dirname(p), { recursive: true });
	writeFileSync(p, text, "utf8");
}

// ---------------------------------------------------------------------------
console.log("\n[1] Defaults when no files exist");
{
	const r = settings.loadSettings(pathsFor("d1"));
	assert(
		eq(r.effective, { ...settings.DEFAULT_SETTINGS }),
		"all 7 keys at defaults",
	);
	assert(
		Object.values(r.sources).every((s) => s === "default"),
		"every source is default",
	);
	assert(r.issues.length === 0, "no issues");
}

// ---------------------------------------------------------------------------
console.log("\n[2] Precedence: project wins per key, per-key sources");
{
	const p = pathsFor("d2");
	writeFile(
		p.globalPath,
		JSON.stringify({ surface: "full", default_kind: "claude" }),
	);
	writeFile(
		p.projectPath,
		JSON.stringify({ surface: "agents", max_parallel_agents: 5 }),
	);
	const r = settings.loadSettings(p);
	assert(
		r.effective.surface === "agents",
		"project overrides global per key (surface)",
	);
	assert(
		r.effective.default_kind === "claude",
		"global key inherited when project silent (default_kind)",
	);
	assert(
		r.effective.max_parallel_agents === 5,
		"project-only key applies (max_parallel_agents)",
	);
	assert(r.effective.max_spawn_depth === 2, "untouched key keeps its default");
	assert(r.sources.surface === "project", "surface source: project");
	assert(r.sources.default_kind === "global", "default_kind source: global");
	assert(
		r.sources.max_parallel_agents === "project",
		"max_parallel_agents source: project",
	);
	assert(r.sources.notifications === "default", "notifications source: default");
}

// ---------------------------------------------------------------------------
console.log("\n[3] deepMerge: objects merge per key, scalars replace");
{
	const merged = settings.deepMerge(
		{ a: 1, nested: { x: 1, keep: true } },
		{ nested: { x: 2, y: 3 }, b: "new" },
	);
	assert(
		eq(merged, { a: 1, nested: { x: 2, keep: true, y: 3 }, b: "new" }),
		"nested objects merge key-by-key, project wins",
	);
	assert(
		settings.deepMerge({ a: 1 }, { a: 2 }).a === 2,
		"scalar replaced by project",
	);
	assert(
		settings.deepMerge([1, 2], [3]).length === 1,
		"arrays replaced, not concatenated",
	);
}

// ---------------------------------------------------------------------------
console.log("\n[4] Malformed JSON reported honestly");
{
	const p = pathsFor("d4");
	writeFile(p.globalPath, JSON.stringify({ max_parallel_agents: 7 }));
	writeFile(p.projectPath, "{ not json ,,");
	const r = settings.loadSettings(p);
	assert(
		r.issues.length === 1 &&
			r.issues[0].path === p.projectPath &&
			/malformed JSON/.test(r.issues[0].problem),
		"malformed project file reported with its path",
	);
	assert(r.effective.max_parallel_agents === 7, "global values still apply");
	assert(
		r.sources.max_parallel_agents === "global",
		"source falls through to global",
	);
	assert(r.effective.surface === "agents", "remaining keys at defaults");
}
{
	const p = pathsFor("d4b");
	writeFile(p.globalPath, "{ oh no");
	writeFile(p.projectPath, "[1,2,3]");
	const r = settings.loadSettings(p);
	assert(r.issues.length === 2, "both malformed files reported");
	assert(
		/not a JSON object/.test(
			r.issues.find((i) => i.path === p.projectPath).problem,
		),
		"non-object top level reported",
	);
	assert(
		eq(r.effective, { ...settings.DEFAULT_SETTINGS }),
		"defaults still resolve",
	);
}

// ---------------------------------------------------------------------------
console.log("\n[5] Invalid values skipped (with issue), other file wins");
{
	const p = pathsFor("d5");
	writeFile(
		p.globalPath,
		JSON.stringify({ max_spawn_depth: "2", notifications: "quiet" }),
	);
	writeFile(
		p.projectPath,
		JSON.stringify({ max_spawn_depth: 0, notifications: "loud", surface: 42 }),
	);
	const r = settings.loadSettings(p);
	assert(
		r.effective.max_spawn_depth === 2,
		"both files' values invalid -> default",
	);
	assert(r.sources.max_spawn_depth === "default", "both invalid -> default");
	assert(
		r.effective.notifications === "quiet",
		"invalid enum falls through to global",
	);
	assert(
		r.effective.surface === "agents",
		"wrong-typed surface rejected -> default",
	);
	assert(
		r.issues.length === 4 && r.issues.every((i) => /ignored/.test(i.problem)),
		"each invalid value reported as ignored",
	);
}

// ---------------------------------------------------------------------------
console.log("\n[6] writeSetting: persist, preserve, refuse malformed");
{
	const p = pathsFor("d6");
	writeFile(
		p.projectPath,
		JSON.stringify({ surface: "full", custom_key: { deep: 1 } }),
	);
	const w = settings.writeSetting(p.projectPath, "max_parallel_agents", 5);
	assert(w.ok, "write ok");
	const onDisk = readJson(p.projectPath);
	assert(onDisk.max_parallel_agents === 5, "new key written");
	assert(onDisk.surface === "full", "existing keys preserved");
	assert(onDisk.custom_key.deep === 1, "unknown keys preserved");
	const r = settings.loadSettings(p);
	assert(
		r.effective.max_parallel_agents === 5 &&
			r.sources.max_parallel_agents === "project",
		"next read sees the write with source project",
	);

	// global write path (dir does not exist yet)
	const w2 = settings.writeSetting(p.globalPath, "agents_kill_switch", true);
	assert(w2.ok, "write creates global file + dirs");
	assert(
		readJson(p.globalPath).agents_kill_switch === true,
		"global write persisted",
	);

	// malformed target refused, untouched
	const broken = join(tmp, "d6", "broken.json");
	writeFile(broken, "{ nope");
	const w3 = settings.writeSetting(broken, "surface", "full");
	assert(
		!w3.ok && /malformed/.test(w3.error),
		"malformed file refused with honest error",
	);
	assert(
		readFileSync(broken, "utf8") === "{ nope",
		"malformed file not clobbered",
	);
}

// ---------------------------------------------------------------------------
// Menu helpers: scripted ctx.ui + recording herdr/kinds seams.
function scriptedCtx(script) {
	const calls = { select: [], confirm: [], input: [], notify: [] };
	const ctx = {
		cwd: tmp,
		hasUI: true,
		ui: {
			select: async (title, options) => {
				calls.select.push({ title, options });
				const next = script.select.shift();
				return next; // undefined = cancel
			},
			confirm: async (title, message) => {
				calls.confirm.push({ title, message });
				return script.confirm.shift() ?? false;
			},
			input: async (title, placeholder) => {
				calls.input.push({ title, placeholder });
				return script.input.shift();
			},
			notify: (message, type = "info") => {
				calls.notify.push({ message, type });
			},
		},
	};
	return { ctx, calls };
}
function herdrRecorder(responses) {
	const calls = [];
	const fn = async (args) => {
		calls.push(args);
		return responses.shift() ?? { ok: true, data: {} };
	};
	return { calls, fn };
}
const kindsFn = async () => ["pi", "claude", "codex"];
const DONE = "Done (close menu)";
const KILL = "Kill all agents";

console.log("\n[7] Menu: flat rows, ordering, sources, restart marker");
{
	const p = pathsFor("m7");
	const { ctx, calls } = scriptedCtx({ select: [DONE] });
	await menu.runSettingsMenu(ctx, { paths: p, kindsFn });
	const first = calls.select[0];
	assert(first.title === "herdr settings", "menu title");
	const expectedOrder = [
		"agents_kill_switch",
		"allow_save_agent",
		"surface",
		"default_kind",
		"max_parallel_agents",
		"max_spawn_depth",
		"notifications",
	];
	const rowKeys = first.options
		.filter((o) => o !== KILL && o !== DONE)
		.map((o) => o.split(" =")[0]);
	assert(eq(rowKeys, expectedOrder), "safety gates -> behavior order");
	assert(
		first.options.at(-2) === KILL && first.options.at(-1) === DONE,
		"Kill-all then Done last",
	);
	const surfaceRow = first.options.find((o) => o.startsWith("surface ="));
	assert(
		surfaceRow ===
			"surface = agents (source: default) — restart required (/reload)",
		"surface row carries source + restart-required marker",
	);
	assert(
		first.options.includes("agents_kill_switch = false (source: default)"),
		"bool row shows key = value (source: …)",
	);
	assert(calls.select.length === 1, "Done exits the loop");
}

console.log(
	"\n[8] Menu: bool toggle persists to chosen file; kill-switch kills nothing",
);
{
	const p = pathsFor("m8");
	const { ctx, calls } = scriptedCtx({
		select: [
			"agents_kill_switch = false (source: default)",
			`Project — ${p.projectPath}`,
			DONE,
		],
	});
	const herdrMock = herdrRecorder([]);
	await menu.runSettingsMenu(ctx, { paths: p, herdrFn: herdrMock.fn, kindsFn });
	assert(
		readJson(p.projectPath).agents_kill_switch === true,
		"toggle persisted true to project file",
	);
	const fs0 = await import("node:fs");
	assert(
		!fs0.existsSync(p.globalPath) && herdrMock.calls.length === 0,
		"no herdr call made, no global file touched (kill-switch is a gate only)",
	);
	assert(
		calls.notify.some(
			(n) =>
				/agents_kill_switch = true saved to/.test(n.message) &&
				n.message.includes(p.projectPath),
		),
		"save notify names the file",
	);
	assert(
		calls.select[2].options.includes(
			"agents_kill_switch = true (source: project)",
		),
		"menu re-renders with new value + source",
	);
}

console.log(
	"\n[9] Menu: enum pick (surface) + save-to-global when global owns the key",
);
{
	const p = pathsFor("m9");
	writeFile(p.globalPath, JSON.stringify({ default_kind: "claude" }));
	const { ctx, calls } = scriptedCtx({
		select: [
			"default_kind = claude (source: global)",
			"pi",
			`Global — ${p.globalPath}`,
			DONE,
		],
	});
	await menu.runSettingsMenu(ctx, { paths: p, kindsFn });
	assert(
		calls.select[1].options.join() === "pi,claude,codex",
		"kind picker uses the live kind list",
	);
	assert(
		calls.select[2].options[0].startsWith("Global —"),
		"owner file offered first",
	);
	assert(readJson(p.globalPath).default_kind === "pi", "global file updated");
	const fs = await import("node:fs");
	assert(
		!fs.existsSync(p.projectPath),
		"project file never created (project checkout untouched)",
	);
}

console.log("\n[10] Menu: number input validates before writing");
{
	const p = pathsFor("m10");
	const { ctx, calls } = scriptedCtx({
		select: ["max_parallel_agents = 3 (source: default)", DONE],
		input: ["0"],
	});
	await menu.runSettingsMenu(ctx, { paths: p, kindsFn });
	assert(
		calls.notify.some(
			(n) => n.type === "error" && /not an integer/.test(n.message),
		),
		"out-of-range input rejected with error notify",
	);
	const fs = await import("node:fs");
	assert(!fs.existsSync(p.projectPath), "nothing written on invalid input");
}
{
	const p = pathsFor("m10b");
	const { ctx } = scriptedCtx({
		select: [
			"max_parallel_agents = 3 (source: default)",
			`Project — ${p.projectPath}`,
			DONE,
		],
		input: ["7"],
	});
	await menu.runSettingsMenu(ctx, { paths: p, kindsFn });
	assert(
		readJson(p.projectPath).max_parallel_agents === 7,
		"valid input persisted",
	);
}

console.log("\n[11] Menu: Kill all agents (declined / confirmed / failure)");
{
	const p = pathsFor("m11");
	const { ctx, calls } = scriptedCtx({ select: [KILL, DONE], confirm: [false] });
	const herdrMock = herdrRecorder([]);
	await menu.runSettingsMenu(ctx, { paths: p, herdrFn: herdrMock.fn, kindsFn });
	assert(herdrMock.calls.length === 0, "declined confirm terminates nothing");
	assert(
		calls.confirm[0].title === "Kill all agents?",
		"confirmation dialog shown",
	);
}
{
	const p = pathsFor("m11b");
	const { ctx, calls } = scriptedCtx({ select: [KILL, DONE], confirm: [true] });
	const herdrMock = herdrRecorder([
		{
			ok: true,
			data: {
				agents: [
					{ pane_id: "w1:p1", name: "a" },
					{ pane_id: "w1:p2", name: "b" },
				],
			},
		},
		{ ok: true, data: {} },
		{ ok: true, data: {} },
	]);
	await menu.runSettingsMenu(ctx, { paths: p, herdrFn: herdrMock.fn, kindsFn });
	assert(eq(herdrMock.calls[0], ["agent", "list"]), "lists agents first");
	assert(eq(herdrMock.calls[1], ["pane", "close", "w1:p1"]), "closes pane 1");
	assert(eq(herdrMock.calls[2], ["pane", "close", "w1:p2"]), "closes pane 2");
	assert(
		calls.notify.some((n) => /Killed 2 agents\./.test(n.message)),
		"success notify",
	);
}
{
	const p = pathsFor("m11c");
	const { ctx, calls } = scriptedCtx({ select: [KILL, DONE], confirm: [true] });
	const herdrMock = herdrRecorder([
		{ ok: true, data: { agents: [{ pane_id: "w1:p1", name: "a" }] } },
		{ ok: false, error: { code: "PANE_GONE", message: "already gone" } },
	]);
	await menu.runSettingsMenu(ctx, { paths: p, herdrFn: herdrMock.fn, kindsFn });
	assert(
		calls.notify.some(
			(n) =>
				n.type === "warning" &&
				/0\/1/.test(n.message) &&
				/already gone/.test(n.message),
		),
		"partial failure reported honestly",
	);
}
{
	const p = pathsFor("m11d");
	const { ctx, calls } = scriptedCtx({ select: [KILL, DONE], confirm: [true] });
	const herdrMock = herdrRecorder([{ ok: true, data: { agents: [] } }]);
	await menu.runSettingsMenu(ctx, { paths: p, herdrFn: herdrMock.fn, kindsFn });
	assert(
		calls.notify.some((n) => /No running agents\./.test(n.message)),
		"empty fleet reported",
	);
}

console.log("\n[12] Menu: malformed file notified, once; cancel path");
{
	const p = pathsFor("m12");
	writeFile(p.projectPath, "{ broken");
	const { ctx, calls } = scriptedCtx({
		select: [
			"surface = agents (source: default) — restart required (/reload)",
			undefined,
			DONE,
		],
	});
	await menu.runSettingsMenu(ctx, { paths: p, kindsFn });
	assert(
		calls.notify.filter(
			(n) => n.type === "warning" && /malformed JSON/.test(n.message),
		).length === 1,
		"malformed file surfaced once (menu re-render does not re-notify)",
	);
	assert(
		calls.select[1].options.join() === "agents,full",
		"enum picker shows surface choices",
	);
}

// ---------------------------------------------------------------------------
console.log(
	"\n[13] Command registration: bare form only, args ignored, UI guard",
);
{
	const ext = await jiti.import(join(ROOT, "src/index.ts"), { parent: ROOT });
	const tools = [];
	const commands = [];
	const events = {};
	const mockPi = {
		registerTool: (def) => tools.push(def),
		registerCommand: (name, def) => commands.push({ name, def }),
		on: (ev, handler) => {
			(events[ev] ??= []).push(handler);
		},
		events: { on: () => () => {}, emit: () => {} },
	};
	await ext.default(mockPi);
	const cmd = commands.find((c) => c.name === "herdr");
	assert(
		!!cmd && typeof cmd.def.handler === "function",
		"/herdr command registered",
	);

	// no UI -> no dialogs, returns without error
	const noUi = {
		cwd: tmp,
		hasUI: false,
		ui: {
			select: async () => {
				throw new Error("no");
			},
		},
	};
	await cmd.def.handler("set surface full", noUi);

	// with UI: args still open the menu (no args form is parsed)
	const { ctx, calls } = scriptedCtx({ select: [DONE] });
	await cmd.def.handler("set surface full", ctx, undefined);
	assert(
		calls.select.length === 1 && calls.select[0].title === "herdr settings",
		"args ignored — bare menu form only",
	);
}

// ---------------------------------------------------------------------------
console.log("\n[14] Schema consistency");
{
	for (const d of settings.SETTING_KEYS) {
		assert(
			settings.DEFAULT_SETTINGS[d.key] === d.default,
			`DEFAULT_SETTINGS.${d.key} matches SETTING_KEYS`,
		);
	}
	assert(
		settings.SETTING_KEYS.filter((d) => d.group === "safety").length === 2,
		"exactly two safety gates first",
	);
}

// ---------------------------------------------------------------------------
rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed (${passed + failed} total)`);
process.exitCode = failed === 0 ? 0 : 1;
