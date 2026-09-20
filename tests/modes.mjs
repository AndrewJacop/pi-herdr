// Offline tests for the v0.6 session modes (issue 09): how a child session
// begins relative to the parent's conversation — standalone (unchanged),
// lineage-only (header `parentSession` link, zero copied turns), fork (the
// parent conversation copied, truncated just before the parent's LAST user
// message, session-entry noise filtered). Covers the pure seeding core, the
// spawn-level `fork: true` override + frontmatter selection, the degrade path
// (no parent conversation available → standalone, honestly recorded), the
// non-pi refusal, and the end-to-end seeding through spawnAgent.
//
// No live herdr server required: every herdr-facing seam is injected.
//
// Run: node tests/modes.mjs

import { createJiti } from "jiti";
import {
	existsSync,
	mkdtempSync,
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
/** Read a session file's JSON lines ([] when empty/unparseable) — lets a
 * not-yet-implemented seeding fail as an assertion, not a crash. */
function jsonLines(path) {
	return readFileSync(path, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((l) => {
			try {
				return JSON.parse(l);
			} catch {
				return { PARSE_FAIL: l };
			}
		});
}

const sf = await jiti.import(join(ROOT, "src/sessionfile.ts"), {
	parent: ROOT,
});
const spawnMod = await jiti.import(join(ROOT, "src/spawn.ts"), { parent: ROOT });
const agentsTool = await jiti.import(join(ROOT, "src/tools/agents.ts"), {
	parent: ROOT,
});

// A stand-in parent conversation: header + a real exchange + session-entry
// noise (model change, compaction, custom extension entry) + the LAST user
// message + the parent's reply to it (everything from that user message on
// must NOT copy — the spawn's task prompt takes that turn's place).
const PARENT_ENTRIES = [
	{ type: "session", version: 3, id: "p-header", timestamp: "t0", cwd: "C:\\p" },
	{
		type: "message",
		id: "m1",
		parentId: null,
		timestamp: "t1",
		message: { role: "user", content: [{ type: "text", text: "design the frobnicator" }] },
	},
	{
		type: "model_change",
		id: "mc1",
		parentId: "m1",
		timestamp: "t1b",
		provider: "prov",
		modelId: "m",
	},
	{
		type: "message",
		id: "m2",
		parentId: "m1",
		timestamp: "t2",
		message: { role: "assistant", content: [{ type: "text", text: "the frobnicator spec" }] },
	},
	{
		type: "compaction",
		id: "c1",
		parentId: "m2",
		timestamp: "t2b",
		summary: "summary",
		firstKeptEntryId: "m2",
		tokensBefore: 100,
	},
	{
		type: "custom",
		customType: "some-extension",
		id: "x1",
		parentId: "m2",
		timestamp: "t2c",
		data: { state: "x" },
	},
	{
		type: "message",
		id: "m3",
		parentId: "m2",
		timestamp: "t3",
		message: { role: "user", content: [{ type: "text", text: "now also the widget" }] },
	},
	{
		type: "message",
		id: "m4",
		parentId: "m3",
		timestamp: "t4",
		message: { role: "assistant", content: [{ type: "text", text: "widget done" }] },
	},
];

// ---------------------------------------------------------------------------
console.log("\n[1] Child header — pi's v3 shape with the parentSession link");
{
	const fixed = new Date("2026-09-20T10:00:00.000Z");
	const h = sf.buildChildHeader(
		{ cwd: "C:\\proj\\alpha", parentSession: "C:\\p\\parent.jsonl" },
		{ now: () => fixed, uuid: () => "child-uuid-1" },
	);
	assert(
		h.type === "session" && h.version === 3,
		"header is {type: session, version: 3} (pi's CURRENT_SESSION_VERSION)",
	);
	assert(h.id === "child-uuid-1", "fresh session id (uuid seam)");
	assert(
		h.timestamp === "2026-09-20T10:00:00.000Z",
		"ISO timestamp (now seam)",
	);
	assert(h.cwd === "C:\\proj\\alpha", "cwd is the CHILD's cwd");
	assert(
		h.parentSession === "C:\\p\\parent.jsonl",
		"parentSession carries the parent session FILE path (what /resume reads)",
	);
	const bare = sf.buildChildHeader({ cwd: "C:\\x" }, { uuid: () => "u" });
	assert(
		!("parentSession" in bare),
		"no parentSession key when there is no parent (standalone never uses this, but the builder is honest)",
	);
}

// ---------------------------------------------------------------------------
console.log("\n[2] Fork copy — truncation boundary (just before the LAST user message)");
{
	const copy = sf.forkCopyEntries(PARENT_ENTRIES);
	const ids = copy.map((e) => e.id);
	assert(
		eq(ids, ["m1", "m2"]),
		`copies m1,m2 — everything before the last user message (${JSON.stringify(ids)})`,
	);
	const roles = copy.map((e) => e.message.role);
	assert(eq(roles, ["user", "assistant"]), "the copied exchange is user→assistant");
	// No user message at all → everything (message entries) copies.
	const noUser = sf.forkCopyEntries([
		PARENT_ENTRIES[0],
		{
			type: "message",
			id: "a1",
			parentId: null,
			timestamp: "t1",
			message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
		},
	]);
	assert(eq(noUser.map((e) => e.id), ["a1"]), "no user message → nothing truncated");
	// Parent conversation mid-turn at spawn time (assistant tool calls after the
	// last user message) — the in-flight tail is dropped WITH the boundary: the
	// last user message is itself the boundary and is excluded (the spawn's
	// task prompt takes its place).
	const midTurn = sf.forkCopyEntries([
		{
			type: "message",
			id: "u1",
			parentId: null,
			timestamp: "t1",
			message: { role: "user", content: [{ type: "text", text: "go" }] },
		},
		{
			type: "message",
			id: "asst",
			parentId: "u1",
			timestamp: "t2",
			message: { role: "assistant", content: [{ type: "toolCall", id: "tc1" }] },
		},
		{
			type: "message",
			id: "tr",
			parentId: "asst",
			timestamp: "t3",
			message: { role: "toolResult", content: [], toolCallId: "tc1" },
		},
	]);
	assert(
		eq(midTurn, []),
		"in-flight parent turn after the last user message does not leak into the child",
	);
}

// ---------------------------------------------------------------------------
console.log("\n[3] Fork copy — noise filter + fresh linear re-chain");
{
	const copy = sf.forkCopyEntries(PARENT_ENTRIES);
	const types = new Set(copy.map((e) => e.type));
	assert(
		eq([...types], ["message"]),
		"only type:message entries copy (model_change/compaction/custom are session-entry noise)",
	);
	assert(
		copy[0].parentId === null && copy[1].parentId === "m1",
		"parentId re-chained linearly (first entry roots the tree; pi's context walk follows parentIds from the leaf)",
	);
	assert(
		copy[1].message === PARENT_ENTRIES[3].message && copy[0].id === "m1" && copy[0].timestamp === "t1",
		"original ids/timestamps/message objects verbatim (traceable to the parent)",
	);
	// A message entry without an id still copies (deterministic fresh id), never dropped.
	const noId = sf.forkCopyEntries([
		{ type: "message", parentId: null, timestamp: "t", message: { role: "user", content: "a" } },
		{
			type: "message",
			id: "ok",
			parentId: null,
			timestamp: "t",
			message: { role: "assistant", content: "reply" },
		},
		{
			type: "message",
			id: "last",
			parentId: "ok",
			timestamp: "t",
			message: { role: "user", content: "b" },
		},
	]);
	assert(
		eq(noId.map((e) => e.id), ["herdr-fork-1", "ok"]) && noId[1].parentId === "herdr-fork-1",
		"id-less message entries get a deterministic id instead of being dropped",
	);
}

// ---------------------------------------------------------------------------
console.log("\n[4] Seed lines — lineage-only vs fork");
{
	const fixed = new Date("2026-09-20T10:00:00.000Z");
	const deps = { now: () => fixed, uuid: () => "child-uuid-1" };
	const lin = sf.buildSessionSeedLines({
		cwd: "C:\\proj",
		parentSession: "C:\\p\\parent.jsonl",
		mode: "lineage-only",
		parentEntries: PARENT_ENTRIES,
	}, deps);
	assert(
		lin.length === 1 && JSON.parse(lin[0]).parentSession === "C:\\p\\parent.jsonl",
		"lineage-only = the header line ONLY (zero copied turns)",
	);
	const fork = sf.buildSessionSeedLines({
		cwd: "C:\\proj",
		parentSession: "C:\\p\\parent.jsonl",
		mode: "fork",
		parentEntries: PARENT_ENTRIES,
	}, deps);
	assert(
		fork.length === 3 && eq(fork.slice(1).map((l) => JSON.parse(l).id), ["m1", "m2"]),
		"fork = header + the copied conversation",
	);
}

// ---------------------------------------------------------------------------
console.log("\n[5] Selection — spawn fork:true forces, frontmatter selects, default standalone");
{
	const dir = mkdtempSync(join(tmpdir(), "pi-herdr-modes-"));
	const parentPath = join(dir, "parent.jsonl");
	writeFileSync(
		parentPath,
		PARENT_ENTRIES.map((e) => JSON.stringify(e)).join("\n"),
	);
	const started = [];
	const deps = () => ({
		load: () => ({
			agents_kill_switch: false,
			default_kind: "pi",
			models: { default: "", agents: {} },
			max_parallel_agents: 4,
			max_spawn_depth: 5,
			notifications: "normal",
			idle_rearm_minutes: 15,
			workflows_enabled: true,
		}),
		kinds: async () => ["pi", "claude"],
		list: async () => [],
		start: async (input) => {
			started.push(input);
			return { ok: true, data: { agent: { pane_id: `w1:p${started.length}` } } };
		},
		boot: async () => ({ ok: true, data: true }),
		submit: async () => ({ ok: true, data: true }),
		status: async () => ({ ok: true, data: "working" }),
		seed: (seededCwd) => {
			const n = started.length;
			const path = join(dir, `seeded-${n}.jsonl`);
			writeFileSync(path, "", { flag: "wx" }); // what the real seam writes: an EMPTY file
			started.seedCwd = seededCwd;
			return { path, dir };
		},
		registry: undefined,
		autodrain: false,
	});
	// No registry: no model pins in this suite — routing stays unset.

	// default: standalone — file stays EMPTY, no mode content
	spawnMod.clearSpawnRegistry();
	const r0 = await spawnMod.spawnAgent(
		{ prompt: "t", agent: { name: "solo", kind: "pi" } },
		{ ...deps(), parentSession: parentPath },
	);
	assert(r0.ok, `standalone spawn ok (${r0.ok ? "" : r0.error.message})`);
	assert(
		readFileSync(join(dir, "seeded-0.jsonl"), "utf8") === "",
		"standalone file stays EMPTY (pi initializes its own header on boot)",
	);

	// spawn-level fork: true — forces fork over the definition
	spawnMod.clearSpawnRegistry();
	const r1 = await spawnMod.spawnAgent(
		{
			prompt: "t",
			agent: { name: "iter", kind: "pi", session_mode: "lineage-only" },
		},
		{ ...deps(), parentSession: parentPath },
	);
	assert(r1.ok, `lineage-only spawn ok (${r1.ok ? "" : r1.error.message})`);
	const lin = jsonLines(join(dir, "seeded-1.jsonl"));
	assert(
		lin.length === 1 && lin[0].parentSession === parentPath,
		"frontmatter session-mode lineage-only seeds header-only with the link",
	);
	assert(
		spawnMod.spawnRecords().get("iter").session_mode === "lineage-only",
		"registry records the mode",
	);

	spawnMod.clearSpawnRegistry();
	const r2 = await spawnMod.spawnAgent(
		{
			prompt: "t",
			agent: { name: "iter", kind: "pi", session_mode: "lineage-only" },
			fork: true,
		},
		{ ...deps(), parentSession: parentPath },
	);
	assert(r2.ok, `fork:true spawn ok (${r2.ok ? "" : r2.error.message})`);
	const fk = jsonLines(join(dir, "seeded-2.jsonl"));
	assert(
		fk.length === 3 && fk[1].id === "m1",
		"fork:true overrides the definition's lineage-only — conversation copies",
	);
	assert(
		spawnMod.spawnRecords().get("iter").session_mode === "fork" &&
			r2.data.session_mode === "fork",
		"registry + spawn result report fork",
	);
	// fork header id is FRESH (not the parent's header id), cwd is the child's
	const header = fk[0] ?? {};
	assert(
		typeof header.id === "string" &&
			header.id !== PARENT_ENTRIES[0].id &&
			header.parentSession === parentPath,
		"child header carries a FRESH id + the parent link",
	);

	// degrade: fork requested but no parent session available → nothing to
	// seed (the file stays empty, pi boots it standalone); the mode still
	// reports what was SELECTED, the file shows what actually happened.
	spawnMod.clearSpawnRegistry();
	const r3 = await spawnMod.spawnAgent(
		{ prompt: "t", agent: { name: "degr", kind: "pi" }, fork: true },
		deps(), // no parentSession dep (in-memory orchestrator session)
	);
	assert(r3.ok, `degraded spawn ok (${r3.ok ? "" : r3.error.message})`);
	assert(
		readFileSync(join(dir, "seeded-3.jsonl"), "utf8") === "",
		"fork with no parent conversation seeds an EMPTY file (≡ standalone on disk)",
	);
	assert(
		spawnMod.spawnRecords().get("degr").session_mode === "fork" &&
			r3.data.session_mode === "fork",
		"mode reports the SELECTION (fork) even when nothing could be copied",
	);

	// unreadable parent path behaves identically
	spawnMod.clearSpawnRegistry();
	const r4 = await spawnMod.spawnAgent(
		{ prompt: "t", agent: { name: "degr2", kind: "pi" }, fork: true },
		{ ...deps(), parentSession: join(dir, "missing.jsonl") },
	);
	assert(
		r4.ok && readFileSync(join(dir, "seeded-4.jsonl"), "utf8") === "",
		"unreadable parent file → no content written (empty file)",
	);

	// non-pi kinds refuse a meaningful session mode (enforce-or-error)
	spawnMod.clearSpawnRegistry();
	const r5 = await spawnMod.spawnAgent(
		{ prompt: "t", agent: { name: "cc", kind: "claude" }, fork: true },
		deps(),
	);
	assert(
		!r5.ok && r5.error.code === "VALIDATION_ERROR" && /session_mode|fork/.test(r5.error.message),
		`fork:true on claude refuses naming the field (${r5.ok ? "spawned!" : r5.error.message})`,
	);

	rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
console.log("\n[6] Tool surface — fork param exists");
{
	const tools = [];
	const mockPi = { registerTool: (d) => tools.push(d), on: () => {} };
	agentsTool.registerAgents(mockPi);
	const spawnTool = tools.find((t) => t.name === "herdr_spawn_agent");
	const props = Object.keys(spawnTool.parameters.properties ?? {});
	assert(
		props.includes("fork"),
		"herdr_spawn_agent schema carries the fork override",
	);
}

const total = passed + failed;
console.log(
	`\n${failed ? "FAIL" : "PASS"}: ${passed}/${total} assertions passed` +
		(failed ? ` — ${failed} failed` : ""),
);
process.exit(failed ? 1 : 0);
