// Offline tests for the fleet widget (v0.6 issue 11).
//
// Sections:
//   [1] pure formatting: MM:SS elapsed, active/open counts + idle flag,
//       table rendering (row shape, right-aligned age, truncation, amber
//       border when nothing is active, blocked callout beneath the box)
//   [2] buildWidgetModel: elapsed freeze at finalizing, rows leave on
//       delivery, state ages from the model vs the first-seen cache
//   [3] fleetWidgetOnce: the ui sink sees the model, the empty fleet clears
//       once, unhealthy observations keep the last-known view
//
// No live herdr server required: every herdr-facing seam is injected.
//
// Run: node tests/widget.mjs

import { createJiti } from "jiti";
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
const eq = (a, b, msg) => assert(a === b, `${msg} (got ${JSON.stringify(a)})`);
const visible = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

const wg = await jiti.import(join(ROOT, "src/widget.ts"), { parent: ROOT });

// ---------------------------------------------------------------------------
console.log("\n[1] Pure formatting: elapsed, counts, rendering");
{
	eq(wg.formatElapsed(0), "00:00", "zero elapsed");
	eq(wg.formatElapsed(23_400), "00:23", "seconds under a minute");
	eq(wg.formatElapsed(75_000), "01:15", "rolls into minutes");
	eq(wg.formatElapsed(4_529_000), "75:29", "minutes exceed 59 without hours");

	// counts: active = {active, starting, running, blocked}; open = the rest
	const model = wg.buildWidgetModel(
		[
			{ name: "scout-auth", spawnedAt: 0, kind: "pi", submitted: true, sawWorking: true },
			{ name: "reviewer-db", spawnedAt: 0, kind: "pi", submitted: true, sawWorking: true },
			{ name: "lint-sweep", spawnedAt: 0, kind: "pi", submitted: true, sawWorking: true },
		],
		[
			{ status: "active", detail: "bash 7m" },
			{ status: "blocked" },
			{ status: "waiting" },
		],
		10_000,
		new Map(),
	);
	eq(model.active, 2, "active counts active + blocked");
	eq(model.open, 1, "open counts the rest");
	eq(model.idle, false, "busy fleet is not idle");
	const idle = wg.buildWidgetModel(
		[{ name: "scout-auth", spawnedAt: 0, kind: "pi", submitted: true, sawWorking: true }],
		[{ status: "waiting" }],
		10_000,
		new Map(),
	);
	eq(idle.active, 0, "nothing active");
	eq(idle.idle, true, "amber flag when active = 0");

	// rendering: box, header, rows with right-aligned ages
	const rendered = wg.renderWidgetLines(model, 80);
	assert(rendered.length >= 5, "header + 3 rows + footer line");
	assert(
		rendered[0].startsWith("╭─ Subagents") && rendered[0].includes("2 active · 1 open"),
		`header carries title + counts: ${visible(rendered[0])}`,
	);
	const row = visible(rendered[1]);
	assert(row.startsWith("│ 00:10"), `row starts with elapsed: ${row}`);
	assert(row.includes("active · bash 7m"), `row carries state · detail: ${row}`);
	const row2 = visible(rendered[2]);
	assert(row2.includes("blocked"), `blocked row renders in the table: ${row2}`);
	assert(
		visible(rendered[1]).length === visible(rendered[2]).length &&
			visible(rendered[1]).endsWith("│"),
		"rows share one box width",
	);
	const ages = rendered
		.slice(1, 4)
		.map((l) => visible(l).replace(/│\s*$/, "").trim().split(/\s+/).pop());
	assert(
		ages.every((a) => /^\d+[smh]/.test(a)),
		`right column is state ages: ${ages.join(",")}`,
	);
	assert(
		rendered.some((l) => l.startsWith("╰─")),
		"box closes with the footer border",
	);

	// border characters always pass through the style adapter (the idle flag
	// picks the COLOR at the call site, not whether the adapter is called)
	let busyCalls = 0;
	wg.renderWidgetLines(model, 80, {
		dim: (s) => s,
		border: (s) => {
			busyCalls++;
			return s;
		},
		inverse: (s) => s,
	});
	assert(busyCalls > 0, "busy fleet styles its border via the adapter");

	// narrow terminal: lines never exceed width, names truncate with ellipsis
	const narrow = wg.renderWidgetLines(model, 40);
	assert(
		narrow.every((l) => visible(l).length <= 40),
		`narrow render respects width: ${narrow.map(visible).join(" | ")}`,
	);
	assert(
		narrow.some((l) => l.includes("…")),
		"narrow render truncates with an ellipsis",
	);

	// blocked callout beneath the box
	const blockedModel = wg.buildWidgetModel(
		[{ name: "reviewer", spawnedAt: 0, kind: "pi", submitted: true, sawWorking: true }],
		[{ status: "blocked", stateAgeMs: 480_000, blockedPreview: "Schema A (wide) or B (tall)?" }],
		10_000,
		new Map(),
	);
	const withCallout = wg.renderWidgetLines(blockedModel, 100);
	const last = visible(withCallout[withCallout.length - 1]);
	assert(
		last.includes("⚠") && last.includes("reviewer BLOCKED") && last.includes("8m"),
		`callout carries name + BLOCKED + age: ${last}`,
	);
	assert(
		last.includes('"Schema A (wide) or B (tall)?"'),
		`callout carries the question preview: ${last}`,
	);
	assert(
		withCallout[withCallout.length - 1].includes("⚠ reviewer BLOCKED"),
		"inverse styling wraps name + BLOCKED (adapter output preserved)",
	);
}

// ---------------------------------------------------------------------------
console.log("\n[2] buildWidgetModel: freeze, pruning, ages");
{
	const NOW = 100_000;

	// elapsed freezes at finalizing via the shared cache
	const cache = new Map();
	const rec = {
		name: "scout",
		paneId: "w1:p2",
		spawnedAt: NOW - 23_000,
		startedAt: NOW - 20_000,
		kind: "pi",
		sessionPath: "/tmp/s.jsonl",
		submitted: true,
		sawWorking: true,
	};
	const running = wg.buildWidgetModel(
		[rec],
		[{ status: "active", detail: "bash 7m", stateAgeMs: 7_000 }],
		NOW,
		cache,
	);
	eq(running.rows[0].elapsedMs, 20_000, "elapsed counts from startedAt");
	const fin = wg.buildWidgetModel(
		[rec],
		[{ status: "finalizing", stateAgeMs: 1_000 }],
		NOW + 5_000,
		cache,
	);
	eq(fin.rows[0].elapsedMs, 25_000, "finalizing freezes the elapsed at its sighting");
	const finLater = wg.buildWidgetModel(
		[rec],
		[{ status: "finalizing", stateAgeMs: 6_000 }],
		NOW + 60_000,
		cache,
	);
	eq(finLater.rows[0].elapsedMs, 25_000, "frozen elapsed stays frozen");

	// frozen elapsed survives a transient blip (finalizing -> active fallback
	// -> finalizing) but a RESUME (fresh startedAt) recomputes honestly
	cache.clear();
	const fin0 = wg.buildWidgetModel(
		[rec],
		[{ status: "finalizing" }],
		NOW + 5_000,
		cache,
	);
	eq(fin0.rows[0].elapsedMs, 25_000, "freeze stamped at finalizing");
	const blip = wg.buildWidgetModel([rec], [{ status: "active" }], NOW + 7_000, cache);
	eq(blip.rows[0].elapsedMs, 25_000, "blip back to active keeps the freeze");
	const resumed = wg.buildWidgetModel(
		[{ ...rec, startedAt: NOW + 8_000 }],
		[{ status: "active" }],
		NOW + 10_000,
		cache,
	);
	eq(resumed.rows[0].elapsedMs, 2_000, "resume (fresh startedAt) recomputes elapsed");

	// rows leave on delivery — the table is in-flight work only
	cache.clear();
	const delivered = { ...rec, delivery: { kind: "done", at: NOW } };
	const pruned = wg.buildWidgetModel([delivered], [{ status: "waiting" }], NOW, cache);
	eq(pruned.rows.length, 0, "delivered record leaves the table");

	// state age comes precomputed on the projection row
	cache.clear();
	const withAge = wg.buildWidgetModel(
		[rec],
		[{ status: "waiting", stateAgeMs: 120_000 }],
		NOW,
		cache,
	);
	eq(withAge.rows[0].stateAgeMs, 120_000, "state age passes through");

	// unknown ages fall back to the first-seen cache keyed by state episode
	cache.clear();
	const b1 = wg.buildWidgetModel([rec], [{ status: "blocked" }], NOW, cache);
	eq(b1.rows[0].stateAgeMs, 0, "first blocked sighting ages from zero");
	const b2 = wg.buildWidgetModel([rec], [{ status: "blocked" }], NOW + 8_000, cache);
	eq(b2.rows[0].stateAgeMs, 8_000, "blocked age grows across ticks");
	const b3 = wg.buildWidgetModel([rec], [{ status: "active" }], NOW + 9_000, cache);
	eq(b3.rows[0].stateAgeMs, 0, "state change restarts the age");

	// record-derived ages: interrupted / stalled / queued
	cache.clear();
	const interrupted = wg.buildWidgetModel(
		[{ ...rec, interruptedAt: NOW - 4_000 }],
		[{ status: "interrupted" }],
		NOW,
		cache,
	);
	eq(interrupted.rows[0].stateAgeMs, 4_000, "interrupted ages from interruptedAt");
	cache.clear();
	const stalled = wg.buildWidgetModel(
		[{ ...rec, watch: { problemSince: NOW - 61_000 } }],
		[{ status: "stalled" }],
		NOW,
		cache,
	);
	eq(stalled.rows[0].stateAgeMs, 61_000, "stalled ages from problemSince");
	cache.clear();
	const queued = wg.buildWidgetModel(
		[{ name: "q", spawnedAt: NOW - 30_000, kind: "pi", submitted: false, sawWorking: false }],
		[{ status: "queued" }],
		NOW,
		cache,
	);
	eq(queued.rows[0].stateAgeMs, 30_000, "queued ages from spawnedAt");
	eq(queued.rows[0].status, "queued", "queued row keeps its state");
}

// ---------------------------------------------------------------------------
console.log("\n[3] fleetWidgetOnce: sink sees the model, empty clears once");
{
	const NOW = 1_000_000;
	const record = {
		name: "scout",
		paneId: "w1:p2",
		spawnedAt: NOW - 10_000,
		startedAt: NOW - 9_000,
		kind: "pi",
		sessionPath: "/tmp/nope.jsonl",
		activityPath: "/tmp/nope.jsonl.activity.json",
		submitted: true,
		sawWorking: true,
		stance: "autonomous",
	};

	function deps({ records = [record], fleetOk = true, live = "working" } = {}) {
		return {
			registry: () => new Map(records.map((r, i) => [r.name ?? "scout", { ...record, ...r, paneId: r.paneId ?? `w1:p${i + 2}` }])),
			fleet: fleetOk
				? { ok: true, data: [{ paneId: "w1:p2", agentStatus: live }] }
				: { ok: false, error: { code: "x", message: "down" } },
			readSidecar: () => ({ state: "missing" }),
			readActivity: () => ({ state: "missing" }),
			extract: () => null,
			now: () => NOW,
		};
	}
	const theme = { fg: (_c, s) => s, inverse: (s) => s, bold: (s) => s };

	// the sink receives a widget for a live fleet
	const seen = [];
	await wg.fleetWidgetOnce({
		...deps(),
		ui: { setWidget: (key, content) => seen.push([key, content]) },
	});
	eq(seen.length, 1, "live fleet sets the widget");
	eq(seen[0][0], "herdr-fleet", "widget key is stable");
	assert(typeof seen[0][1] === "function", "content is a render factory");
	assert(seen[0][1]({}, theme).render(80)[0].includes("Subagents"), "factory renders the table");

	// non-pi passthrough reports coarse running
	const coarse = wg.buildWidgetModel(
		[{ name: "codex-1", paneId: "w1:p3", spawnedAt: NOW - 5_000, kind: "codex", submitted: true, sawWorking: true }],
		[{ status: "running" }],
		NOW,
		new Map(),
	);
	eq(coarse.rows[0].status, "running", "non-pi pane renders coarse running");

	// activity snapshot detail flows into the row
	const snapModel = wg.buildWidgetModel(
		[record],
		[{ status: "active", detail: "bash 7m" }],
		NOW,
		new Map(),
	);
	assert(snapModel.rows[0].detail === "bash 7m", "snapshot detail (`active · bash 7m`) rides the row");

	// question preview extracted from the session's last assistant message
	const previewSeen = [];
	await wg.fleetWidgetOnce({
		...deps({ live: "blocked" }),
		extract: (path) =>
			path === record.sessionPath
				? { message: {}, text: "Schema A (wide) or B (tall) for the pivot?\n(one line of the child's last message)" }
				: null,
		ui: {
			setWidget: (_k, factory) => {
				previewSeen.push(factory({}, theme).render(120).join("\n"));
			},
		},
	});
	assert(
		previewSeen[0]?.includes("Schema A (wide) or B (tall)"),
		"blocked callout previews the child's last message",
	);

	// empty registry clears once, then stops touching the sink
	const clears = [];
	const sink = { setWidget: (key, content) => clears.push([key, content]) };
	await wg.fleetWidgetOnce({ ...deps({ records: [] }), fleet: { ok: true, data: [] }, ui: sink });
	await wg.fleetWidgetOnce({ ...deps({ records: [] }), fleet: { ok: true, data: [] }, ui: sink });
	eq(clears.length, 1, "empty fleet clears the widget exactly once");
	eq(clears[0][1], undefined, "clear passes undefined content");

	// unhealthy fleet: rows render last-known (a failed tick never blanks the table)
	const unhealthySeen = [];
	await wg.fleetWidgetOnce({
		...deps({ fleetOk: false }),
		ui: { setWidget: (_k, factory) => unhealthySeen.push(factory({}, theme).render(80).join("\n")) },
	});
	assert(unhealthySeen[0]?.includes("scout"), "failed fleet observation keeps the last-known view");

	// every record delivered → the widget CLEARS (no empty amber shell):
	// the registry never shrinks, so an empty-ROWS view must clear too
	const deliveredSeen = [];
	const deliveredDeps = deps({ records: [{ ...record, delivery: { kind: "done", at: NOW } }] });
	await wg.fleetWidgetOnce({
		...deliveredDeps,
		fleet: { ok: true, data: [{ paneId: "w1:p2", agentStatus: "idle" }] },
		ui: { setWidget: (key, content) => deliveredSeen.push([key, content]) },
	});
	eq(deliveredSeen.length, 1, "all-delivered fleet clears the widget");
	eq(deliveredSeen[0][1], undefined, "all-delivered clear passes undefined (no shell)");
	await wg.fleetWidgetOnce({
		...deliveredDeps,
		fleet: { ok: true, data: [] },
		ui: { setWidget: (_k, _c) => deliveredSeen.push(["again", "x"]) },
	});
	eq(deliveredSeen.length, 1, "clear stays cleared (no repeated setWidget)");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
