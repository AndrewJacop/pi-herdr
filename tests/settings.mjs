// Tests for the settings layer (src/settings.ts) and the /subagents config
// menu (src/menu.ts) — v0.6 issue 02: the new key table (models.*,
// idle_rearm_minutes, workflows_enabled; surface + allow_save_agent gone),
// deep merge + per-key source, the flat menu, persistence (nested paths,
// record entries, unset-by-delete), kill-switch-is-a-gate-only.
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
		eq(r.effective, JSON.parse(JSON.stringify(settings.DEFAULT_SETTINGS))),
		"all keys at defaults (incl. the models structure)",
	);
	assert(
		r.effective.models.default === "" &&
			eq(r.effective.models.agents, {}) &&
			r.effective.idle_rearm_minutes === 15 &&
			r.effective.workflows_enabled === true,
		"models.default unset, models.agents empty, idle_rearm 15, workflows on",
	);
	assert(
		!("surface" in r.effective) && !("allow_save_agent" in r.effective),
		"surface and allow_save_agent are gone from the key table",
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
		JSON.stringify({
			default_kind: "claude",
			models: { default: "openai/gpt-5.2" },
		}),
	);
	writeFile(
		p.projectPath,
		JSON.stringify({ default_kind: "pi", max_parallel_agents: 5 }),
	);
	const r = settings.loadSettings(p);
	assert(
		r.effective.default_kind === "pi",
		"project overrides global per key (default_kind)",
	);
	assert(
		r.effective.models.default === "openai/gpt-5.2",
		"global models.default inherited when project silent (nested key)",
	);
	assert(
		r.effective.max_parallel_agents === 5,
		"project-only key applies (max_parallel_agents)",
	);
	assert(r.effective.max_spawn_depth === 2, "untouched key keeps its default");
	assert(r.sources.default_kind === "project", "default_kind source: project");
	assert(
		r.sources["models.default"] === "global",
		"models.default source: global (nested path)",
	);
	assert(
		r.sources.max_parallel_agents === "project",
		"max_parallel_agents source: project",
	);
	assert(r.sources.notifications === "default", "notifications source: default");
}

// ---------------------------------------------------------------------------
console.log("\n[3] models.agents: per-name merge across both files");
{
	const p = pathsFor("d3");
	writeFile(
		p.globalPath,
		JSON.stringify({
			models: { agents: { scout: "global/model", worker: "global/model" } },
		}),
	);
	writeFile(
		p.projectPath,
		JSON.stringify({
			models: { agents: { scout: "project/model", extra: "project/model" } },
		}),
	);
	const r = settings.loadSettings(p);
	assert(
		eq(r.effective.models.agents, {
			scout: "project/model",
			worker: "global/model",
			extra: "project/model",
		}),
		"entries merge across files, project winning per name",
	);
	assert(
		r.sources["models.agents.<name>"] === "project",
		"record source: highest-precedence contributor (project)",
	);
}
{
	// global-only record
	const p = pathsFor("d3b");
	writeFile(
		p.globalPath,
		JSON.stringify({ models: { agents: { scout: "global/model" } } }),
	);
	const r = settings.loadSettings(p);
	assert(
		eq(r.effective.models.agents, { scout: "global/model" }),
		"global-only record applies",
	);
	assert(
		r.sources["models.agents.<name>"] === "global",
		"record source: global when only global contributed",
	);
}

// ---------------------------------------------------------------------------
console.log("\n[4] deepMerge: objects merge per key, scalars replace");
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
console.log("\n[5] Malformed JSON reported honestly");
{
	const p = pathsFor("d5");
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
	assert(r.effective.default_kind === "pi", "remaining keys at defaults");
}
{
	const p = pathsFor("d5b");
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
		eq(r.effective, JSON.parse(JSON.stringify(settings.DEFAULT_SETTINGS))),
		"defaults still resolve",
	);
}

// ---------------------------------------------------------------------------
console.log("\n[6] Invalid values skipped (with issue), other file wins");
{
	const p = pathsFor("d6");
	writeFile(
		p.globalPath,
		JSON.stringify({ max_spawn_depth: "2", notifications: "quiet" }),
	);
	writeFile(
		p.projectPath,
		JSON.stringify({
			max_spawn_depth: 0,
			notifications: "loud",
			idle_rearm_minutes: 0,
			models: { default: "", agents: { scout: 42 } },
		}),
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
		r.effective.idle_rearm_minutes === 15,
		"out-of-floor number rejected -> default",
	);
	assert(
		r.effective.models.default === "",
		"empty models.default rejected -> default (unset)",
	);
	assert(
		eq(r.effective.models.agents, {}),
		"record with a non-string value rejected wholesale -> default",
	);
	assert(
		r.issues.length === 6 && r.issues.every((i) => /ignored/.test(i.problem)),
		"each invalid value reported as ignored (6: depth×2, notifications, idle_rearm, models.default, models.agents)",
	);
}

// ---------------------------------------------------------------------------
console.log(
	"\n[7] writeSetting: nested persist, preserve, unset-by-delete, refuse malformed",
);
{
	const p = pathsFor("d7");
	writeFile(
		p.projectPath,
		JSON.stringify({
			models: { default: "old/model", agents: { keep: "keep/model" } },
			custom_key: { deep: 1 },
		}),
	);
	const w = settings.writeSetting(p.projectPath, "models.default", "new/model");
	assert(w.ok, "nested write ok");
	const onDisk = readJson(p.projectPath);
	assert(
		onDisk.models.default === "new/model" &&
			onDisk.models.agents.keep === "keep/model",
		"nested key written, sibling branch preserved",
	);
	assert(onDisk.custom_key.deep === 1, "unknown keys preserved");

	// null DELETES the key (unset is absence, never a sentinel) and prunes
	// the now-empty parent — but never a parent that still has entries.
	const w2 = settings.writeSetting(p.projectPath, "models.default", null);
	assert(w2.ok, "unset write ok");
	const d2 = readJson(p.projectPath);
	assert(d2.models.default === undefined, "null deletes the nested key");
	assert(
		d2.models.agents.keep === "keep/model",
		"sibling entries survive the delete",
	);

	// null on the RECORD key deletes the whole record (documented unset
	// semantics) — the menu never does this (it uses writeRecordEntry for
	// per-name pins), but the write layer's contract is whole-key.
	const w3 = settings.writeSetting(p.projectPath, "models.agents.<name>", null);
	assert(w3.ok, "record-key null write ok");
	assert(
		readJson(p.projectPath).models?.agents === undefined,
		"record null write removes models.agents (whole-key delete)",
	);

	// scalar write still lands top-level
	const w4 = settings.writeSetting(p.projectPath, "max_parallel_agents", 5);
	assert(
		w4.ok && readJson(p.projectPath).max_parallel_agents === 5,
		"top-level write",
	);

	// global write path (dir does not exist yet)
	const w5 = settings.writeSetting(p.globalPath, "agents_kill_switch", true);
	assert(w5.ok, "write creates global file + dirs");
	assert(
		readJson(p.globalPath).agents_kill_switch === true,
		"global write persisted",
	);

	// malformed target refused, untouched
	const broken = join(tmp, "d7", "broken.json");
	writeFile(broken, "{ nope");
	const w6 = settings.writeSetting(broken, "models.default", "x/y");
	assert(
		!w6.ok && /malformed/.test(w6.error),
		"malformed file refused with honest error",
	);
	assert(
		readFileSync(broken, "utf8") === "{ nope",
		"malformed file not clobbered",
	);
}

// ---------------------------------------------------------------------------
console.log("\n[8] writeRecordEntry: one models.agents pin at a time");
{
	const p = pathsFor("d8");
	writeFile(
		p.projectPath,
		JSON.stringify({ models: { agents: { scout: "old/model" } } }),
	);
	const w = settings.writeRecordEntry(
		p.projectPath,
		"models.agents.<name>",
		"scout",
		"new/model",
	);
	assert(w.ok, "entry write ok");
	assert(
		readJson(p.projectPath).models.agents.scout === "new/model",
		"entry overwritten in place",
	);
	settings.writeRecordEntry(
		p.projectPath,
		"models.agents.<name>",
		"worker",
		"w/m",
	);
	assert(
		readJson(p.projectPath).models.agents.worker === "w/m",
		"new entry added alongside",
	);
	// removing the LAST entry prunes the empty container
	settings.writeRecordEntry(
		p.projectPath,
		"models.agents.<name>",
		"worker",
		null,
	);
	settings.writeRecordEntry(
		p.projectPath,
		"models.agents.<name>",
		"scout",
		null,
	);
	const d = readJson(p.projectPath);
	assert(
		d.models === undefined || d.models.agents === undefined,
		"empty models.agents pruned (no {} husk)",
	);
	// resolution round-trip
	const r = settings.loadSettings(p);
	assert(eq(r.effective.models.agents, {}), "next read sees the empty record");
}

// ---------------------------------------------------------------------------
// Menu helpers: scripted ctx.ui + recording herdr/kinds seams.
function scriptedCtx(script) {
	const calls = { select: [], confirm: [], input: [], notify: [] };
	const s = { select: [], confirm: [], input: [], ...script };
	const ctx = {
		cwd: tmp,
		hasUI: true,
		ui: {
			select: async (title, options) => {
				calls.select.push({ title, options });
				return s.select.shift();
			},
			confirm: async (title, message) => {
				calls.confirm.push({ title, message });
				return s.confirm.shift() ?? false;
			},
			input: async (title, placeholder) => {
				calls.input.push({ title, placeholder });
				return s.input.shift();
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

console.log("\n[9] Menu: flat rows, ordering, sources, no restart markers");
{
	const p = pathsFor("m9");
	const { ctx, calls } = scriptedCtx({ select: [DONE] });
	await menu.runSettingsMenu(ctx, { paths: p, kindsFn });
	const first = calls.select[0];
	assert(first.title === "subagents config", "menu title");
	const expectedOrder = [
		"agents_kill_switch",
		"default_kind",
		"models.default",
		"models.agents.<name>",
		"max_parallel_agents",
		"max_spawn_depth",
		"notifications",
		"idle_rearm_minutes",
		"workflows_enabled",
	];
	const rowKeys = first.options
		.filter((o) => o !== KILL && o !== DONE)
		.map((o) => o.split(" =")[0]);
	assert(eq(rowKeys, expectedOrder), "safety gate -> behavior order");
	assert(
		first.options.at(-2) === KILL && first.options.at(-1) === DONE,
		"Kill-all then Done last",
	);
	assert(
		first.options.includes("agents_kill_switch = false (source: default)"),
		"bool row shows key = value (source: …)",
	);
	assert(
		first.options.includes("models.default = (unset) (source: default)"),
		"unset string renders as (unset)",
	);
	assert(
		first.options.includes("models.agents.<name> = {} (source: default)"),
		"empty record renders as {}",
	);
	assert(
		first.options.every((o) => !/restart required/.test(o)),
		"no restart-required markers left (surface died)",
	);
	assert(calls.select.length === 1, "Done exits the loop");
}

console.log(
	"\n[10] Menu: bool toggle persists to owning file; kill-switch kills nothing",
);
{
	const p = pathsFor("m10");
	const { ctx, calls } = scriptedCtx({
		select: ["agents_kill_switch = false (source: default)", DONE],
	});
	const herdrMock = herdrRecorder([]);
	await menu.runSettingsMenu(ctx, { paths: p, herdrFn: herdrMock.fn, kindsFn });
	assert(
		readJson(p.projectPath).agents_kill_switch === true,
		"default-sourced key writes the project file",
	);
	const fs0 = await import("node:fs");
	assert(
		!fs0.existsSync(p.globalPath) && herdrMock.calls.length === 0,
		"no herdr call made, no global file touched (kill-switch is a gate only)",
	);
	assert(
		calls.select.every((s) => !s.title.startsWith("Save ")),
		"no save-target prompt — write goes to the owning file",
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
		calls.select[1].options.includes(
			"agents_kill_switch = true (source: project)",
		),
		"menu re-renders with new value + source",
	);
}

console.log(
	"\n[11] Menu: enum pick (default_kind) + global-owned key writes global",
);
{
	const p = pathsFor("m11");
	writeFile(p.globalPath, JSON.stringify({ default_kind: "claude" }));
	const { ctx, calls } = scriptedCtx({
		select: ["default_kind = claude (source: global)", "pi", DONE],
	});
	await menu.runSettingsMenu(ctx, { paths: p, kindsFn });
	assert(
		calls.select[1].options.join() === "pi,claude,codex",
		"kind picker uses the live kind list",
	);
	assert(
		calls.select.every(
			(s) => s.title === "subagents config" || s.title.startsWith("default_kind"),
		),
		"no save-target dialog — the global owner file is written directly",
	);
	assert(readJson(p.globalPath).default_kind === "pi", "global file updated");
	const fs = await import("node:fs");
	assert(
		!fs.existsSync(p.projectPath),
		"project file never created (project checkout untouched)",
	);
}

console.log("\n[12] Menu: number input validates before writing");
{
	const p = pathsFor("m12");
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
	const p = pathsFor("m12b");
	const { ctx } = scriptedCtx({
		select: ["max_parallel_agents = 3 (source: default)", DONE],
		input: ["7"],
	});
	await menu.runSettingsMenu(ctx, { paths: p, kindsFn });
	assert(
		readJson(p.projectPath).max_parallel_agents === 7,
		"valid input persisted",
	);
}

console.log("\n[13] Menu: models.default free input, set and unset");
{
	const p = pathsFor("m13");
	const { ctx, calls } = scriptedCtx({
		select: ["models.default = (unset) (source: default)", DONE],
		input: ["anthropic/claude-sonnet-4.5"],
	});
	await menu.runSettingsMenu(ctx, { paths: p, kindsFn });
	assert(
		readJson(p.projectPath).models.default === "anthropic/claude-sonnet-4.5",
		"free model id persisted nested",
	);
	assert(
		calls.select[1].options.includes(
			"models.default = anthropic/claude-sonnet-4.5 (source: project)",
		),
		"row re-renders with the pin",
	);
}
{
	// empty input on a pinned key clears it (delete, not a sentinel write)
	const p = pathsFor("m13b");
	writeFile(p.projectPath, JSON.stringify({ models: { default: "old/model" } }));
	const { ctx, calls } = scriptedCtx({
		select: ["models.default = old/model (source: project)", DONE],
		input: [""],
	});
	await menu.runSettingsMenu(ctx, { paths: p, kindsFn });
	assert(
		readJson(p.projectPath).models === undefined,
		"empty input unsets the pin and prunes the empty models object",
	);
	assert(
		calls.select[1].options.includes(
			"models.default = (unset) (source: default)",
		),
		"row re-renders as unset",
	);
}

console.log("\n[14] Menu: models.agents pin add/edit/remove via two inputs");
{
	const p = pathsFor("m14");
	const { ctx, calls } = scriptedCtx({
		select: ["models.agents.<name> = {} (source: default)", DONE],
		input: ["scout", "openai/gpt-5.2"],
	});
	await menu.runSettingsMenu(ctx, { paths: p, kindsFn });
	assert(
		eq(readJson(p.projectPath).models.agents, { scout: "openai/gpt-5.2" }),
		"pin written nested under models.agents",
	);
	assert(
		calls.select[1].options.includes(
			"models.agents.<name> = { scout: openai/gpt-5.2 } (source: project)",
		),
		"record row renders entries compactly",
	);
}
{
	// empty name cancels; nothing written
	const p = pathsFor("m14b");
	const { ctx } = scriptedCtx({
		select: ["models.agents.<name> = {} (source: default)", DONE],
		input: [""],
	});
	await menu.runSettingsMenu(ctx, { paths: p, kindsFn });
	const fs = await import("node:fs");
	assert(!fs.existsSync(p.projectPath), "empty name cancels the edit");
}
{
	// empty model removes an existing pin
	const p = pathsFor("m14c");
	writeFile(
		p.projectPath,
		JSON.stringify({ models: { agents: { scout: "a/b", keep: "c/d" } } }),
	);
	const { ctx, calls } = scriptedCtx({
		select: [
			"models.agents.<name> = { scout: a/b, keep: c/d } (source: project)",
			DONE,
		],
		input: ["scout", ""],
	});
	await menu.runSettingsMenu(ctx, { paths: p, kindsFn });
	assert(
		eq(readJson(p.projectPath).models.agents, { keep: "c/d" }),
		"empty model removes just that pin",
	);
	assert(
		calls.select[1].options.includes(
			"models.agents.<name> = { keep: c/d } (source: project)",
		),
		"row re-renders without the pin",
	);
}
{
	// cross-file removal: a pin that lives in GLOBAL while the row's source is
	// project must still disappear (the record is the per-name merge of both
	// files — removal clears it from every file that has it).
	const p = pathsFor("m14d");
	writeFile(
		p.globalPath,
		JSON.stringify({ models: { agents: { scout: "g/m" } } }),
	);
	writeFile(
		p.projectPath,
		JSON.stringify({ models: { agents: { worker: "p/m" } } }),
	);
	const { ctx, calls } = scriptedCtx({
		select: [
			"models.agents.<name> = { scout: g/m, worker: p/m } (source: project)",
			DONE,
		],
		input: ["scout", ""],
	});
	await menu.runSettingsMenu(ctx, { paths: p, kindsFn });
	assert(
		readJson(p.globalPath).models === undefined,
		"removal reaches into the global file (pruned empty)",
	);
	assert(
		eq(readJson(p.projectPath).models.agents, { worker: "p/m" }),
		"project entries untouched",
	);
	assert(
		calls.select[1].options.includes(
			"models.agents.<name> = { worker: p/m } (source: project)",
		),
		"row re-renders without the cross-file pin",
	);
	// and removal never CREATES a missing file
	const fs = await import("node:fs");
	const p2 = pathsFor("m14e");
	const { ctx: c2, calls: k2 } = scriptedCtx({
		select: ["models.agents.<name> = {} (source: default)", DONE],
		input: ["ghost", ""],
	});
	await menu.runSettingsMenu(c2, { paths: p2, kindsFn });
	assert(
		k2.notify.some((n) => /nothing to remove/.test(n.message)),
		"unpinned name refused honestly",
	);
	assert(
		!fs.existsSync(p2.projectPath) && !fs.existsSync(p2.globalPath),
		"no file created just to delete from it",
	);
}

console.log("\n[15] Menu: Kill all agents (declined / confirmed / failure)");
{
	const p = pathsFor("m15");
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
	const p = pathsFor("m15b");
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
	const p = pathsFor("m15c");
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
	const p = pathsFor("m15d");
	const { ctx, calls } = scriptedCtx({ select: [KILL, DONE], confirm: [true] });
	const herdrMock = herdrRecorder([{ ok: true, data: { agents: [] } }]);
	await menu.runSettingsMenu(ctx, { paths: p, herdrFn: herdrMock.fn, kindsFn });
	assert(
		calls.notify.some((n) => /No running agents\./.test(n.message)),
		"empty fleet reported",
	);
}

console.log("\n[16] Menu: malformed file notified once; cancel path");
{
	const p = pathsFor("m16");
	writeFile(p.projectPath, "{ broken");
	const { ctx, calls } = scriptedCtx({
		select: ["idle_rearm_minutes = 15 (source: default)", undefined, DONE],
	});
	await menu.runSettingsMenu(ctx, { paths: p, kindsFn });
	assert(
		calls.notify.filter(
			(n) => n.type === "warning" && /malformed JSON/.test(n.message),
		).length === 1,
		"malformed file surfaced once (menu re-render does not re-notify)",
	);
	assert(
		calls.input.length === 1 && calls.input[0].title.startsWith("idle_rearm"),
		"number editor prompts once, cancelled input aborts the edit",
	);
}

// ---------------------------------------------------------------------------
console.log(
	"\n[17] /subagents command: bare + config open the menu; unknown word refused",
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
	const cmd = commands.find((c) => c.name === "subagents");
	assert(
		!!cmd && typeof cmd.def.handler === "function",
		"/subagents command registered",
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
	await cmd.def.handler("config", noUi);
	await cmd.def.handler("", noUi);

	// bare form opens the menu
	const bare = scriptedCtx({ select: [DONE] });
	await cmd.def.handler("", bare.ctx, undefined);
	assert(
		bare.calls.select.length === 1 &&
			bare.calls.select[0].title === "subagents config",
		"bare /subagents opens the settings menu",
	);

	// /subagents config opens the menu
	const cfg = scriptedCtx({ select: [DONE] });
	await cmd.def.handler("config", cfg.ctx, undefined);
	assert(
		cfg.calls.select.length === 1 &&
			cfg.calls.select[0].title === "subagents config",
		"/subagents config opens the settings menu",
	);

	// an unknown sibling word is answered with a pointer, no menu
	const unk = scriptedCtx({ select: [DONE] });
	await cmd.def.handler("kill-all", unk.ctx, undefined);
	assert(
		unk.calls.select.length === 0 &&
			unk.calls.notify.some(
				(n) =>
					n.type === "warning" && /Unknown \/subagents kill-all/.test(n.message),
			),
		"unknown sibling word refused with a pointer (room to grow)",
	);
}

// ---------------------------------------------------------------------------
console.log("\n[18] Schema consistency");
{
	for (const d of settings.SETTING_KEYS) {
		assert(
			JSON.stringify(settings.readSettingValue(settings.DEFAULT_SETTINGS, d)) ===
				JSON.stringify(d.default),
			`DEFAULT_SETTINGS matches SETTING_KEYS for ${d.key}`,
		);
	}
	assert(
		settings.SETTING_KEYS.filter((d) => d.group === "safety").length === 1,
		"exactly one safety gate first",
	);
	assert(
		!settings.SETTING_KEYS.some(
			(d) => d.key === "surface" || d.key === "allow_save_agent",
		),
		"surface / allow_save_agent absent from the key table",
	);
}

// ---------------------------------------------------------------------------
rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed (${passed + failed} total)`);
process.exitCode = failed === 0 ? 0 : 1;
