// Offline tests for the lifecycle actions (v0.6 issue 10): herdr_interrupt_agent
// (turn-level cancel: Escape via the existing key-send machinery, the
// interruptedAt stamp the projection reads, the honest refusals) and the
// stop-and-redirect composition with herdr_message_agent.
//
// No live herdr server required: every herdr-facing seam is injected.
//
// Run: node tests/lifecycle.mjs

import { createJiti } from "jiti";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
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

const msg = await jiti.import(join(ROOT, "src/tools/message.ts"), {
	parent: ROOT,
});
const lifecycle = await jiti.import(join(ROOT, "src/tools/lifecycle.ts"), {
	parent: ROOT,
});
// NOTE: imported via the `.js` specifier so jiti resolves it to the SAME
// module instance the engines use internally — the live spawn-registry map
// is shared state, and the resume tests drive it through
// putSpawnRecordForTests/clearSpawnRegistry.
const spawnMod = await jiti.import(join(ROOT, "src/spawn.js"), { parent: ROOT });
const settingsMod = await jiti.import(join(ROOT, "src/settings.ts"), {
	parent: ROOT,
});

// ---- seam helpers -------------------------------------------------------------

const okGet = (paneId, name, status) => async () => ({
	ok: true,
	data: { paneId, name, status },
});
const notFound = () => async () => ({
	ok: false,
	error: { code: "NOT_FOUND", message: "no such agent" },
});
const recorder = () => {
	const calls = [];
	const fn = async (...args) => {
		calls.push(args);
		return { ok: true, data: true };
	};
	fn.calls = calls;
	return fn;
};
/** A registry record like spawnAgent leaves behind (live pi child). */
const record = (over = {}) => ({
	name: "scout",
	kind: "pi",
	type: "Explore",
	prompt: "do things",
	agentArgs: [],
	depth: 2,
	isolated: false,
	spawnedAt: 1,
	submitted: true,
	sawWorking: true,
	paneId: "w1:p9",
	stance: "interactive",
	...over,
});
const registryWith = (records) => () => {
	const m = new Map();
	for (const r of records) m.set(r.name, r);
	return m;
};
const DEPS = (over = {}) => ({
	registry: registryWith([]),
	agentGet: okGet("w1:p1", "scout", "working"),
	sendKeys: recorder(),
	now: () => 1_000_000,
	...over,
});

// ---------------------------------------------------------------------------
console.log("\n[1] Interrupt — resolution chain");
{
	// registry handle
	const sendKeys = recorder();
	const rec = record();
	const r = await lifecycle.interruptAgent(
		{ target: "scout" },
		DEPS({
			registry: registryWith([rec]),
			agentGet: okGet("w1:p9", "scout", "working"),
			sendKeys,
		}),
	);
	assert(r.ok, "registry handle resolves");
	assert(
		sendKeys.calls[0]?.[0] === "w1:p9" && sendKeys.calls[0]?.[1]?.[0] === "esc",
		"Escape goes to the record's pane via the key-send machinery",
	);

	// pane id → registry record (byPane)
	const sendKeys2 = recorder();
	const rec2 = record();
	const r2 = await lifecycle.interruptAgent(
		{ target: "w1:p9" },
		DEPS({
			registry: registryWith([rec2]),
			agentGet: okGet("w1:p9", "scout", "working"),
			sendKeys: sendKeys2,
		}),
	);
	assert(
		r2.ok && sendKeys2.calls[0]?.[0] === "w1:p9",
		"pane id resolves through the registry (byPane)",
	);

	// herdr name → agent get → byPane
	const sendKeys3 = recorder();
	const rec3 = record();
	const r3 = await lifecycle.interruptAgent(
		{ target: "some-herdr-name" },
		DEPS({
			registry: registryWith([rec3]),
			agentGet: okGet("w1:p9", "some-herdr-name", "working"),
			sendKeys: sendKeys3,
		}),
	);
	assert(
		r3.ok && sendKeys3.calls[0]?.[0] === "w1:p9",
		"herdr name resolves via agent get → byPane",
	);

	// unknown target
	const r4 = await lifecycle.interruptAgent(
		{ target: "nobody" },
		DEPS({ agentGet: notFound() }),
	);
	assert(
		!r4.ok && r4.error.code === "NOT_FOUND",
		"unknown target errors NOT_FOUND",
	);
	assert(
		r4.error.message.includes("herdr_send_keys"),
		"the unknown-target error points at the raw Escape escape hatch",
	);
}

console.log("\n[2] Interrupt — honest refusals");
{
	// non-pi kind
	const r = await lifecycle.interruptAgent(
		{ target: "claud" },
		DEPS({
			registry: registryWith([record({ name: "claud", kind: "claude" })]),
			agentGet: okGet("w1:p9", "claud", "working"),
		}),
	);
	assert(
		!r.ok && r.error.code === "VALIDATION_ERROR",
		"non-pi kind refused",
	);
	assert(
		r.error.message.includes("herdr_send_keys"),
		"the non-pi refusal points at herdr_send_keys",
	);

	// queued (no pane yet, no startError)
	const rq = await lifecycle.interruptAgent(
		{ target: "queued" },
		DEPS({
			registry: registryWith([record({ name: "queued", paneId: undefined })]),
		}),
	);
	assert(!rq.ok, "queued record refused (no pane to interrupt)");

	// never started
	const rs = await lifecycle.interruptAgent(
		{ target: "dead" },
		DEPS({
			registry: registryWith([
				record({ name: "dead", paneId: undefined, startError: "boot failed" }),
			]),
		}),
	);
	assert(!rs.ok, "never-started record refused");

	// gone pane → the resume pointer
	const rg = await lifecycle.interruptAgent(
		{ target: "gone" },
		DEPS({
			registry: registryWith([record({ name: "gone" })]),
			agentGet: notFound(),
		}),
	);
	assert(!rg.ok && rg.error.code === "NOT_FOUND", "gone pane refused");
	assert(
		rg.error.message.includes("herdr_resume_agent"),
		"the gone refusal names herdr_resume_agent (the recovery move)",
	);

	// settled — nothing to cancel
	const ri = await lifecycle.interruptAgent(
		{ target: "scout" },
		DEPS({
			registry: registryWith([record()]),
			agentGet: okGet("w1:p9", "scout", "idle"),
		}),
	);
	assert(
		!ri.ok && ri.error.code === "VALIDATION_ERROR",
		"settled (idle) pane refused — nothing to cancel",
	);

	// blocked IS interruptible (abandoning the question is a turn cancel)
	const sendKeys = recorder();
	const rb = await lifecycle.interruptAgent(
		{ target: "scout" },
		DEPS({
			registry: registryWith([record()]),
			agentGet: okGet("w1:p9", "scout", "blocked"),
			sendKeys,
		}),
	);
	assert(rb.ok && sendKeys.calls.length === 1, "blocked pane is interruptible");
}

console.log("\n[3] Interrupt — happy path: the flag the projection reads");
{
	const rec = record();
	const r = await lifecycle.interruptAgent(
		{ target: "scout" },
		DEPS({
			registry: registryWith([rec]),
			agentGet: okGet("w1:p9", "scout", "working"),
			now: () => 1_234_567,
		}),
	);
	assert(r.ok, "interrupt succeeds on a working child");
	assert(rec.interruptedAt === 1_234_567, "interruptedAt stamped on the record");
	assert(
		r.data.interrupted === true &&
			r.data.name === "scout" &&
			r.data.target === "w1:p9" &&
			r.data.was === "working",
		"receipt carries {interrupted, name, target, was}",
	);

	// send failure: honest error, flag NOT stamped
	const rec2 = record();
	const badKeys = async () => ({
		ok: false,
		error: { code: "VALIDATION_ERROR", message: "send failed" },
	});
	const r2 = await lifecycle.interruptAgent(
		{ target: "scout" },
		DEPS({
			registry: registryWith([rec2]),
			agentGet: okGet("w1:p9", "scout", "working"),
			sendKeys: badKeys,
		}),
	);
	assert(!r2.ok, "send failure surfaces as an error");
	assert(rec2.interruptedAt === undefined, "no stamp when the Escape never landed");

	// transport failure on the live check is NOT absence evidence
	const r3 = await lifecycle.interruptAgent(
		{ target: "scout" },
		DEPS({
			registry: registryWith([record()]),
			agentGet: async () => ({
				ok: false,
				error: { code: "TIMEOUT", message: "herdr down" },
			}),
		}),
	);
	assert(
		!r3.ok && r3.error.code === "TIMEOUT",
		"a failed live check surfaces honestly (never read as gone)",
	);
}

console.log("\n[4] Composition — message_agent ends the interrupt (stop-and-redirect)");
{
	const rec = record({ interruptedAt: 999 });
	let flagAtSend;
	const send = async () => {
		flagAtSend = rec.interruptedAt;
		return { ok: true, data: true };
	};
	const r = await msg.messageAgent(
		{ target: "scout", text: "stop that; summarize what you have" },
		{
			registry: registryWith([rec]),
			agentGet: okGet("w1:p9", "scout", "working"),
			send,
			env: {},
		},
	);
	assert(r.ok, "message delivered to the interrupted child");
	assert(
		flagAtSend === undefined,
		"the flag is cleared BEFORE the send — new work is authoritative",
	);
	assert(rec.interruptedAt === undefined, "interruptedAt cleared by the delivery");

	// a message to a NON-record pane touches no flag (adopted panes)
	const r2 = await msg.messageAgent(
		{ target: "w1:p3", text: "hello" },
		DEPS({ agentGet: okGet("w1:p3", "adopted", "working"), send: recorder() }),
	);
	assert(r2.ok, "message to an adopted pane still works");
}

console.log("\n[5] Resume — refusals (handle-only, substrate, state, gates)");
{
	const GONE_REC = (over = {}) =>
		record({
			sessionPath: "\\\\ses\\dir\\s.jsonl",
			definition: { name: "scout", kind: "pi" },
			...over,
		});
	const goneDeps = (over = {}) =>
		DEPS({
			fleet: async () => ({ ok: true, data: [] }),
			load: () => ({ ...settingsMod.DEFAULT_SETTINGS }),
			env: {},
			childExtension: "child.ts",
			autodrain: false,
			...over,
		});

	// raw path target — never a path, always a handle
	{
		const r = await lifecycle.resumeAgent(
			{ target: "C:\\ses\\dir\\s.jsonl" },
			goneDeps(),
		);
		assert(
			!r.ok && r.error.code === "NOT_FOUND",
			"a raw path target is refused",
		);
		assert(
			r.error.message.includes("HANDLE"),
			"the path refusal names the registry-handle rule",
		);
	}

	// unknown handle
	{
		const r = await lifecycle.resumeAgent({ target: "ghost" }, goneDeps());
		assert(!r.ok && r.error.code === "NOT_FOUND", "unknown handle refused");
	}

	// non-pi record — nothing to replay
	{
		spawnMod.clearSpawnRegistry();
		spawnMod.putSpawnRecordForTests(
			GONE_REC({ name: "claud", kind: "claude", sessionPath: undefined }),
		);
		const r = await lifecycle.resumeAgent({ target: "claud" }, goneDeps());
		assert(
			!r.ok && r.error.code === "VALIDATION_ERROR",
			"non-pi record refused (no pi session to replay)",
		);
	}

	// still live — interrupt or message instead
	{
		spawnMod.clearSpawnRegistry();
		const rec = GONE_REC();
		spawnMod.putSpawnRecordForTests(rec);
		const r = await lifecycle.resumeAgent(
			{ target: "scout" },
			goneDeps({
				fleet: async () => ({
					ok: true,
					data: [{ paneId: rec.paneId, name: "scout", agentStatus: "working" }],
				}),
			}),
		);
		assert(
			!r.ok && r.error.code === "VALIDATION_ERROR",
			"a live pane is refused — resume is for gone agents",
		);
		assert(
			r.error.message.includes("herdr_interrupt_agent"),
			"the live-pane refusal points at interrupt/message",
		);
	}

	// still queued
	{
		spawnMod.clearSpawnRegistry();
		spawnMod.putSpawnRecordForTests(GONE_REC({ paneId: undefined }));
		const r = await lifecycle.resumeAgent(
			{ target: "scout" },
			goneDeps({
				fleet: async () => ({ ok: true, data: [] }),
			}),
		);
		assert(
			!r.ok && r.error.code === "VALIDATION_ERROR",
			"a queued record is refused (it is not gone)",
		);
	}

	// kill-switch gate
	{
		spawnMod.clearSpawnRegistry();
		spawnMod.putSpawnRecordForTests(GONE_REC());
		const r = await lifecycle.resumeAgent(
			{ target: "scout" },
			goneDeps({
				load: () => ({
					...settingsMod.DEFAULT_SETTINGS,
					agents_kill_switch: true,
				}),
			}),
		);
		assert(
			!r.ok && r.error.code === "SPAWN_REFUSED",
			"kill-switch refuses the resume (same gates as any spawn)",
		);
	}

	// spawn-depth gate
	{
		spawnMod.clearSpawnRegistry();
		spawnMod.putSpawnRecordForTests(GONE_REC());
		const r = await lifecycle.resumeAgent(
			{ target: "scout" },
			goneDeps({ env: { PI_HERDR_SPAWN_DEPTH: "3" } }),
		);
		assert(
			!r.ok && r.error.code === "SPAWN_REFUSED",
			"spawn-depth gate refuses the resume",
		);
	}

	// kind re-derivation: the definition has no kind; default_kind changed
	// since death — the retained file is a pi session, so this refuses.
	{
		spawnMod.clearSpawnRegistry();
		spawnMod.putSpawnRecordForTests(
			GONE_REC({ type: undefined, definition: { name: "scout" } }),
		);
		const r = await lifecycle.resumeAgent(
			{ target: "scout" },
			goneDeps({
				load: () => ({
					...settingsMod.DEFAULT_SETTINGS,
					default_kind: "claude",
				}),
			}),
		);
		assert(
			!r.ok && r.error.code === "VALIDATION_ERROR",
			"re-derived non-pi kind refused — --session is pi-only",
		);
		assert(
			r.error.message.includes("pi"),
			"the kind refusal names the pi-session reason",
		);
	}

	// routing validation: a bad definition model pin still refuses (enforce-
	// or-error survives death)
	{
		spawnMod.clearSpawnRegistry();
		spawnMod.putSpawnRecordForTests(
			GONE_REC({
				type: undefined,
				definition: { name: "scout", kind: "pi", model: "not-a-pair" },
			}),
		);
		const r = await lifecycle.resumeAgent({ target: "scout" }, goneDeps());
		assert(
			!r.ok && r.error.code === "VALIDATION_ERROR",
			"a bad model pin refuses at resume (enforce-or-error, resolved now)",
		);
	}

	// unresolvable definition and no snapshot: honest refusal
	{
		spawnMod.clearSpawnRegistry();
		spawnMod.putSpawnRecordForTests(
			GONE_REC({ type: undefined, definition: undefined }),
		);
		const r = await lifecycle.resumeAgent({ target: "scout" }, goneDeps());
		assert(
			!r.ok && r.error.code === "VALIDATION_ERROR",
			"no definition (anonymous inline, no snapshot) refuses honestly",
		);
	}
}

console.log("\n[6] Resume — happy path: relaunch on the retained session");
{
	const dir = mkdtempSync(join(tmpdir(), "pi-herdr-lifecycle-"));
	const sessionPath = join(dir, "s.jsonl");
	writeFileSync(sessionPath, "");
	// stale sidecars from the dead run — the resume MUST clear them
	writeFileSync(`${sessionPath}.exit`, JSON.stringify({ type: "done" }));
	writeFileSync(`${sessionPath}.takeover`, JSON.stringify({ at: 1 }));
	writeFileSync(`${sessionPath}.activity.json`, "{\"version\":1}");

	spawnMod.clearSpawnRegistry();
	const rec = record({
		type: "scout", // resolvable later via agentDirs; falls back until then
		sessionPath,
		activityPath: `${sessionPath}.activity.json`,
		definition: { name: "scout", kind: "pi" }, // no model pin
		routing: { model: "prov/old", thinking: undefined, modelSource: "models-default", thinkingSource: "unset" },
		delivery: { kind: "gone", at: 1 },
		goneAt: 1,
		watch: { stalled: true },
		startError: undefined,
		takenOver: true,
		tookNotified: true,
		interruptedAt: 1,
	});
	spawnMod.putSpawnRecordForTests(rec);

	const calls = { start: [], submit: [], boot: [] };
	const r = await lifecycle.resumeAgent(
		{ target: "scout", message: "continue: report the magic word" },
		{
			fleet: async () => ({ ok: true, data: [] }), // gone
			load: () => ({
				...settingsMod.DEFAULT_SETTINGS,
				models: { ...settingsMod.DEFAULT_SETTINGS.models, default: "prov/new" },
			}),
			// pi's model registry (threaded from ctx in the real tool)
			registry: {
				find: (provider, id) => ({ provider, id }),
				hasConfiguredAuth: () => true,
			},
			env: {},
			childExtension: "child.ts",
			autodrain: false,
			start: async (input) => {
				calls.start.push(input);
				return { ok: true, data: { agent: { pane_id: "w2:p5" } } };
			},
			boot: async (paneId) => {
				calls.boot.push(paneId);
				return { ok: true, data: true };
			},
			submit: async (paneId, text) => {
				calls.submit.push({ paneId, text });
				return { ok: true, data: true };
			},
			status: async () => ({ ok: true, data: "working" }),
		},
	);
	assert(r.ok, `resume succeeds (${r.ok ? "" : r.error.message})`);
	assert(
		calls.start.length === 1 && calls.start[0].name === "scout",
		"the pane relaunches through the one launch path (same handle)",
	);
	assert(r.data.paneId === "w2:p5" && rec.paneId === "w2:p5", "fresh paneId recorded");
	assert(
		r.data.sessionPath === sessionPath && rec.sessionPath === sessionPath,
		"SAME retained session file (the registry holds it)",
	);
	const plan = rec.launchPlan ?? [];
	assert(
		plan.includes("--session") && plan.includes(sessionPath) && plan.includes("child.ts"),
		"the launch plan replays the retained session (--session) + the injected extension",
	);
	assert(
		plan.includes("--model") && plan.includes("prov/new"),
		"routing RE-RESOLVED now: the settings change since death took effect",
	);
	assert(
		rec.routing?.model === "prov/new" && rec.routing?.modelSource === "models-default",
		"record.routing carries the fresh resolution",
	);
	assert(
		calls.submit.length === 1 &&
			calls.submit[0].paneId === "w2:p5" &&
			calls.submit[0].text === "continue: report the magic word",
		"the optional message is submitted as the opening prompt",
	);
	assert(rec.prompt === "continue: report the magic word", "record.prompt = the resume message");
	assert(
		!existsSync(`${sessionPath}.exit`) &&
			!existsSync(`${sessionPath}.takeover`) &&
			!existsSync(`${sessionPath}.activity.json`),
		"stale sidecars cleared — the old done can never re-deliver",
	);
	assert(
		rec.delivery === undefined &&
			rec.goneAt === undefined &&
			rec.watch === undefined &&
			rec.takenOver === false &&
			rec.tookNotified === false &&
			rec.interruptedAt === undefined &&
			rec.startError === undefined,
		"transient state reset — the resumed run is a fresh watchable run",
	);
	assert(r.data.resumed === true, "receipt marks the resume");

	// re-resolve via a REAL registry file: fresh .md edits apply
	const dirs = { project: join(dir, "agents"), global: join(dir, "g") };
	mkdirSync(dirs.project, { recursive: true });
	writeFileSync(
		join(dirs.project, "scout.md"),
		"---\nname: scout\nkind: pi\n---\nfrontmatter body v2\n",
	);
	const r2 = await lifecycle.resumeAgent(
		{ target: "scout", message: "again" },
		{
			fleet: async () => ({ ok: true, data: [] }),
			load: () => ({ ...settingsMod.DEFAULT_SETTINGS }),
			env: {},
			childExtension: "child.ts",
			autodrain: false,
			agentDirs: dirs,
			start: async () => ({ ok: true, data: { agent: { pane_id: "w2:p6" } } }),
			boot: async () => ({ ok: true, data: true }),
			submit: async () => ({ ok: true, data: true }),
			status: async () => ({ ok: true, data: "working" }),
		},
	);
	assert(r2.ok, "re-resume after the first relaunch (its pane is gone too)");
	assert(
		(rec.agentArgs ?? []).includes("frontmatter body v2"),
		"a resolvable type re-reads the .md — fresh frontmatter edits apply",
	);
	writeFileSync(
		join(dirs.project, "scout.md"),
		"---\nname: scout\nkind: pi\n---\nfrontmatter body v3\n",
	);
	const r3 = await lifecycle.resumeAgent(
		{ target: "scout", message: "once more" },
		{
			fleet: async () => ({ ok: true, data: [] }),
			load: () => ({ ...settingsMod.DEFAULT_SETTINGS }),
			env: {},
			childExtension: "child.ts",
			autodrain: false,
			agentsDirsMarker: undefined,
			agentDirs: dirs,
			start: async () => ({ ok: true, data: { agent: { pane_id: "w2:p7" } } }),
			boot: async () => ({ ok: true, data: true }),
			submit: async () => ({ ok: true, data: true }),
			status: async () => ({ ok: true, data: "working" }),
		},
	);
	assert(
		r3.ok && (rec.agentArgs ?? []).includes("frontmatter body v3"),
		"the next resume picks up the NEW edit (resolved now, not at spawn)",
	);
	rmSync(dir, { recursive: true, force: true });
}

console.log("\n[7] Resume — queue at cap, silent resume, isolated worktree kept");
{
	// cap: the resume is ACCEPTED queued (same gates as spawn), the drain
	// starts it with the resume message as the opening prompt
	const dir = mkdtempSync(join(tmpdir(), "pi-herdr-lifecycle-q-"));
	const sessionPath = join(dir, "s.jsonl");
	writeFileSync(sessionPath, "");
	spawnMod.clearSpawnRegistry();
	const rec = record({
		sessionPath,
		activityPath: `${sessionPath}.activity.json`,
		definition: { name: "scout", kind: "pi" },
	});
	spawnMod.putSpawnRecordForTests(rec);
	spawnMod.putSpawnRecordForTests(
		record({ name: "other", paneId: "w1:p2" }), // holds the only slot
	);
	const submits = [];
	const starts = [];
	const baseDeps = {
		fleet: async () => ({
			ok: true,
			data: [{ paneId: "w1:p2", name: "other", agentStatus: "working" }],
		}),
		load: () => ({
			...settingsMod.DEFAULT_SETTINGS,
			max_parallel_agents: 1,
		}),
		env: {},
		childExtension: "child.ts",
		autodrain: false,
		start: async (input) => {
			starts.push(input);
			return { ok: true, data: { agent: { pane_id: `w3:p${starts.length}` } } };
		},
		boot: async () => ({ ok: true, data: true }),
		submit: async (paneId, text) => {
			submits.push({ paneId, text });
			return { ok: true, data: true };
		},
		status: async () => ({ ok: true, data: "working" }),
	};
	const rq = await lifecycle.resumeAgent(
		{ target: "scout", message: "queued work" },
		baseDeps,
	);
	assert(
		rq.ok && rq.data.queued === true,
		"over-cap resume is accepted queued (same gates as spawn)",
	);
	assert(
		rec.paneId === undefined && !rec.startError,
		"the dead paneId is dropped so the drain picks the record up",
	);
	assert(starts.length === 0, "no pane started while at cap");
	const started = await spawnMod.drainQueueOnce(baseDeps);
	assert(started === 1, "the drain starts the queued resume when a slot frees");
	assert(
		submits.length === 1 && submits[0].text === "queued work",
		"the drain submits the resume message as the opening prompt",
	);

	// silent resume (no message): boot IS the handoff — nothing is submitted
	spawnMod.clearSpawnRegistry();
	const rec2 = record({
		sessionPath,
		activityPath: `${sessionPath}.activity.json`,
		definition: { name: "scout", kind: "pi" },
		prompt: "the original task",
	});
	spawnMod.putSpawnRecordForTests(rec2);
	const silentSubmits = [];
	const rs = await lifecycle.resumeAgent(
		{ target: "scout" },
		{
			...baseDeps,
			fleet: async () => ({ ok: true, data: [] }),
			load: () => ({ ...settingsMod.DEFAULT_SETTINGS }),
			submit: async (paneId, text) => {
				silentSubmits.push({ paneId, text });
				return { ok: true, data: true };
			},
			status: async () => ({ ok: true, data: "idle" }),
		},
	);
	assert(rs.ok, `silent resume succeeds (${rs.ok ? "" : rs.error.message})`);
	assert(
		silentSubmits.length === 0,
		"a message-less resume submits NOTHING (the old task is not re-run)",
	);
	assert(rs.data.status === "idle", "the receipt reports the replayed, open pane");
	assert(
		rec2.prompt === "the original task" && rec2.resumeSilent === true,
		"silent flag rides the record (a queued silent resume stays silent)",
	);

	// isolated resume keeps its worktree — no second worktree is created
	spawnMod.clearSpawnRegistry();
	const rec3 = record({
		sessionPath,
		activityPath: `${sessionPath}.activity.json`,
		definition: { name: "scout", kind: "pi" },
		isolated: true,
		worktreePath: join(dir, "wt"),
	});
	spawnMod.putSpawnRecordForTests(rec3);
	let worktreeCalls = 0;
	let startedCwd;
	const rw = await lifecycle.resumeAgent(
		{ target: "scout", message: "back to it" },
		{
			...baseDeps,
			fleet: async () => ({ ok: true, data: [] }),
			load: () => ({ ...settingsMod.DEFAULT_SETTINGS }),
			worktree: async () => {
				worktreeCalls++;
				return { ok: true, data: join(dir, "other-wt") };
			},
			start: async (input) => {
				startedCwd = input.cwd;
				return { ok: true, data: { agent: { pane_id: "w4:p1" } } };
			},
		},
	);
	assert(rw.ok, "isolated resume succeeds");
	assert(worktreeCalls === 0, "the retained worktree is reused — no second worktree");
	assert(startedCwd === join(dir, "wt"), "the child cwd is the retained worktree");
	rmSync(dir, { recursive: true, force: true });
}

console.log("\n[8] The spawn-time definition snapshot precedes routing");
{
	// A REAL spawnAgent run (not a hand-made record): with models.default
	// supplying the model, the snapshot stamped on the record must NOT carry
	// the resolved pin — otherwise a fallback-path resume replays the dead
	// run's routing at frontmatter level instead of re-resolving NOW
	// (found by review; the happy-path tests used hand-made snapshots).
	spawnMod.clearSpawnRegistry();
	const calls = { start: [] };
	const sr = await spawnMod.spawnAgent(
		{
			prompt: "snapshot pin probe",
			name: "snapsh",
			agent: { name: "snapsh", kind: "pi" },
		},
		{
			load: () => ({
				...settingsMod.DEFAULT_SETTINGS,
				models: { ...settingsMod.DEFAULT_SETTINGS.models, default: "prov/snapA" },
			}),
			registry: {
				find: (provider, id) => ({ provider, id }),
				hasConfiguredAuth: () => true,
			},
			list: async () => [],
			kinds: async () => ["pi", "claude"],
			start: async (input) => {
				calls.start.push(input);
				return { ok: true, data: { agent: { pane_id: "w9:p1" } } };
			},
			boot: async () => ({ ok: true, data: true }),
			submit: async () => ({ ok: true, data: true }),
			status: async () => ({ ok: true, data: "working" }),
			env: {},
			autodrain: false,
		},
	);
	assert(sr.ok, `spawnAgent runs (${sr.ok ? "" : sr.error.message})`);
	const snapRec = spawnMod.spawnRecords().get("snapsh");
	assert(
		snapRec?.definition?.model === undefined,
		"the snapshot carries NO resolved model (pre-routing capture)",
	);
	assert(
		snapRec?.routing?.model === "prov/snapA" &&
			snapRec?.routing?.modelSource === "models-default",
		"the record's routing still carries the live resolution",
	);

	// and the fallback-path resume on that REAL record re-resolves: change
	// settings between spawn and resume → the relaunch rides the NEW model
	const rr = await lifecycle.resumeAgent(
		{ target: "snapsh", message: "go on" },
		{
			fleet: async () => ({ ok: true, data: [{ paneId: snapRec.paneId, name: "snapsh", agentStatus: "working" }] }),
			load: () => ({
				...settingsMod.DEFAULT_SETTINGS,
				models: { ...settingsMod.DEFAULT_SETTINGS.models, default: "prov/snapA" },
			}),
			env: {},
			childExtension: "child.ts",
			autodrain: false,
			start: async (input) => {
				calls.start.push(input);
				return { ok: true, data: { agent: { pane_id: "w9:p2" } } };
			},
			boot: async () => ({ ok: true, data: true }),
			submit: async () => ({ ok: true, data: true }),
			status: async () => ({ ok: true, data: "working" }),
			registry: {
				find: (provider, id) => ({ provider, id }),
				hasConfiguredAuth: () => true,
			},
		},
	);
	// the live pane check must refuse first — release the pane, then resume
	assert(!rr.ok, "live-pane guard fires before the resume");
	const rr2 = await lifecycle.resumeAgent(
		{ target: "snapsh", message: "go on" },
		{
			fleet: async () => ({ ok: true, data: [] }),
			load: () => ({
				...settingsMod.DEFAULT_SETTINGS,
				models: { ...settingsMod.DEFAULT_SETTINGS.models, default: "prov/snapB" },
			}),
			env: {},
			childExtension: "child.ts",
			autodrain: false,
			start: async (input) => {
				calls.start.push(input);
				return { ok: true, data: { agent: { pane_id: "w9:p3" } } };
			},
			boot: async () => ({ ok: true, data: true }),
			submit: async () => ({ ok: true, data: true }),
			status: async () => ({ ok: true, data: "working" }),
			registry: {
				find: (provider, id) => ({ provider, id }),
				hasConfiguredAuth: () => true,
			},
		},
	);
	assert(rr2.ok, `fallback resume runs (${rr2.ok ? "" : rr2.error.message})`);
	assert(
		snapRec.routing?.model === "prov/snapB" &&
			snapRec.routing?.modelSource === "models-default",
		"the fallback resume re-resolves to the CHANGED settings (prov/snapB, not the dead run's prov/snapA)",
	);
	const plan2 = snapRec.launchPlan ?? [];
	assert(
		plan2.includes("prov/snapB") && !plan2.includes("prov/snapA"),
		"the new launch plan rides the re-resolved model",
	);
}

// ---------------------------------------------------------------------------
console.log(`\n[done] ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
