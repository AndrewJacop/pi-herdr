// Offline tests for the v0.6 substrate (issue 04): the parent-owned session
// file (pi-default dir shape, seeding), the completion sidecar typing, the
// exact last-assistant-message JSONL extraction, stance derivation, the pi
// launch-plan injection (--session + -e), the child extension (pure fns +
// registration against a mock pi), and the get_agent_result engine paths.
//
// No live herdr server required: every herdr-facing seam is injected.
//
// Run: node tests/substrate.mjs

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const sf = await jiti.import(join(ROOT, "src/sessionfile.ts"), {
	parent: ROOT,
});
const child = await jiti.import(join(ROOT, "src/child.ts"), { parent: ROOT });
const spawnMod = await jiti.import(join(ROOT, "src/spawn.ts"), {
	parent: ROOT,
});
const resultMod = await jiti.import(join(ROOT, "src/tools/result.ts"), {
	parent: ROOT,
});
const agentsTool = await jiti.import(join(ROOT, "src/tools/agents.ts"), {
	parent: ROOT,
});

// ---------------------------------------------------------------------------
console.log("\n[1] Session-dir shape — pi's default encoding");
{
	assert(
		sf.sessionsDirName("C:\\Users\\Andrew") === "--C--Users-Andrew--",
		"Windows cwd encodes exactly like observed pi dirs (--C--Users-Andrew--)",
	);
	assert(
		sf.sessionsDirName("/home/u/proj") === "--home-u-proj--",
		"POSIX cwd strips the leading slash and flattens separators",
	);
	assert(
		sf.sessionsDirName("D:\\Me\\pi herdr") === "--D--Me-pi herdr--",
		"separators/colons collapse to dashes, spaces kept (pi's exact encoding)",
	);
	assert(
		sf
			.sessionsDirFor("C:\\x", "C:\\home\\agent")
			.endsWith(join("sessions", "--C--x--")),
		"sessionsDirFor = <agentDir>/sessions/<encoded>",
	);
}

// ---------------------------------------------------------------------------
console.log("\n[2] Seeding — parent-owned file before launch");
{
	const agentDir = mkdtempSync(join(tmpdir(), "pi-herdr-seed-"));
	const fixed = new Date("2026-09-19T12:34:56.789Z");
	const seeded = sf.seedSessionFile("C:\\proj\\alpha", {
		agentDir,
		now: () => fixed,
		uuid: () => "test-uuid-1234",
	});
	assert(
		seeded.path.endsWith("_test-uuid-1234.jsonl"),
		`filename is <timestamp>_<uuid>.jsonl (${seeded.path.split(/[\\/]/).pop()})`,
	);
	assert(
		seeded.path.split(/[\\/]/).pop().startsWith("2026-09-19T12-34-56-789Z_"),
		"timestamp uses pi's :/. → - form",
	);
	assert(
		existsSync(seeded.path) && readFileSync(seeded.path, "utf8") === "",
		"file exists and is EMPTY (pi initializes a --session empty file itself)",
	);
	assert(
		existsSync(join(agentDir, "sessions", "--C--proj-alpha--")),
		"created under the pi-default dir for the child cwd",
	);
	// sidecar path convention
	assert(
		sf.sidecarPathFor(seeded.path) === `${seeded.path}.exit`,
		"sidecar sits beside the session (<session>.exit)",
	);
	rmSync(agentDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
console.log("\n[3] JSONL extraction — the exact last assistant message");
{
	const entries = [
		{ type: "session", version: 1, id: "s1", cwd: "C:\\x" },
		{
			type: "message",
			id: "e1",
			message: { role: "user", content: "do the thing", timestamp: 1 },
		},
		{
			type: "message",
			id: "e2",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "interim" }],
				stopReason: "toolUse",
				timestamp: 2,
			},
		},
		{ type: "custom", customType: "x", data: {} },
		{
			type: "message",
			id: "e3",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "hm" },
					{ type: "text", text: "final line one" },
					{ type: "toolCall", id: "t1", name: "read" },
					{ type: "text", text: "final line two" },
				],
				stopReason: "stop",
				timestamp: 3,
			},
		},
	];
	const parsed = sf.parseSessionEntries(
		entries.map((e) => JSON.stringify(e)).join("\n"),
	);
	assert(
		parsed.entries.length === 5 && parsed.malformed === 0,
		"all lines parse",
	);
	const ex = sf.extractLastAssistant(parsed.entries);
	assert(!!ex, "extracts the last assistant message");
	assert(
		eq(ex.message, entries[4].message),
		"message object is VERBATIM (round-trips byte-identically)",
	);
	assert(
		ex.text === "final line one\nfinal line two",
		"text = text blocks joined, thinking/toolCall blocks excluded",
	);
	assert(
		sf.extractLastAssistant([
			{ type: "message", message: { role: "user", content: "x" } },
		]) === null,
		"no assistant message → null",
	);
	// torn final line (child mid-write): skipped, never fatal
	const torn = `${JSON.stringify(entries[0])}\n${JSON.stringify(entries[1])}\n{"type":"mess`;
	const tornParsed = sf.parseSessionEntries(torn);
	assert(tornParsed.malformed === 1, "torn final line counted malformed");
	assert(
		sf.extractLastAssistant(tornParsed.entries) === null,
		"extraction tolerates a torn tail (user message is not a result)",
	);
}

// ---------------------------------------------------------------------------
console.log("\n[4] Sidecar typing — {type:done|error} with mined payload");
{
	assert(
		eq(sf.parseExitSidecar('{"type":"done"}').sidecar, { type: "done" }),
		"done parses",
	);
	const errP = sf.parseExitSidecar(
		'{"type":"error","stopReason":"error","errorMessage":"overloaded"}',
	);
	assert(
		errP.ok &&
			errP.sidecar.type === "error" &&
			errP.sidecar.stopReason === "error" &&
			errP.sidecar.errorMessage === "overloaded",
		"error sidecar keeps stopReason + errorMessage",
	);
	const noMsg = sf.parseExitSidecar('{"type":"error"}');
	assert(
		noMsg.ok && noMsg.sidecar.errorMessage.includes("stopReason=error"),
		"error without a message gets an honest fallback message",
	);
	assert(!sf.parseExitSidecar("{oops").ok, "malformed JSON → invalid");
	assert(
		!sf.parseExitSidecar('{"type":"ping"}').ok,
		"unknown payload type → invalid",
	);
	assert(
		eq(sf.minedAssistantError({ stopReason: "error", errorMessage: " 429 " }), {
			stopReason: "error",
			errorMessage: "429",
		}),
		"minedAssistantError trims and requires stopReason=error",
	);
	assert(
		sf.minedAssistantError({ stopReason: "stop" }) === null &&
			sf.minedAssistantError({ stopReason: "aborted" }) === null,
		"normal/aborted messages carry no mined error",
	);

	// readExitSidecar against disk
	const dir = mkdtempSync(join(tmpdir(), "pi-herdr-side-"));
	const sess = join(dir, "s.jsonl");
	writeFileSync(sess, "");
	assert(sf.readExitSidecar(sess).state === "missing", "no sidecar → missing");
	writeFileSync(`${sess}.exit`, '{"type":"done"}');
	assert(
		eq(sf.readExitSidecar(sess).sidecar, { type: "done" }),
		"done sidecar reads from <session>.exit",
	);
	writeFileSync(`${sess}.exit`, "not json");
	assert(
		sf.readExitSidecar(sess).state === "invalid",
		"garbage sidecar → invalid",
	);
	rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
console.log("\n[5] Stance — autonomous default, interactive override");
{
	assert(
		spawnMod.deriveStance({}) === "autonomous",
		"unset fields → autonomous",
	);
	assert(
		spawnMod.deriveStance({ auto_exit: true }) === "autonomous",
		"auto_exit: true → autonomous",
	);
	assert(
		spawnMod.deriveStance({ auto_exit: false }) === "interactive",
		"auto_exit: false → interactive",
	);
	assert(
		spawnMod.deriveStance({ interactive: true }) === "interactive",
		"interactive: true → interactive (override)",
	);
	assert(
		spawnMod.deriveStance({ interactive: true, auto_exit: true }) ===
			"interactive",
		"interactive wins over auto_exit",
	);
}

// ---------------------------------------------------------------------------
console.log("\n[6] Child extension — pure fns");
{
	assert(
		child.shouldAutoExitOnSettle([{ role: "assistant", stopReason: "stop" }]) ===
			true,
		"normal stop → auto-exit",
	);
	assert(
		child.shouldAutoExitOnSettle([{ role: "assistant", stopReason: "error" }]) ===
			true,
		"error stop → still exits (typed error sidecar tells the parent)",
	);
	assert(
		child.shouldAutoExitOnSettle([
			{ role: "assistant", stopReason: "aborted" },
		]) === false,
		"aborted → stays open for inspection",
	);
	assert(
		child.shouldAutoExitOnSettle(undefined) === true,
		"no messages → default exit",
	);
	const mined = child.findLatestAssistantError([
		{ role: "user", content: "x" },
		{
			role: "assistant",
			stopReason: "error",
			errorMessage: "provider overloaded",
		},
	]);
	assert(
		eq(mined, { errorMessage: "provider overloaded", stopReason: "error" }),
		"mines the latest assistant error",
	);
	assert(
		eq(
			child.buildCompletionSidecar([{ role: "assistant", stopReason: "stop" }]),
			{
				type: "done",
			},
		),
		"sidecar typing: settled normal → done",
	);
	assert(
		eq(
			child.buildCompletionSidecar([
				{ role: "assistant", stopReason: "error", errorMessage: "boom" },
			]),
			{
				type: "error",
				errorMessage: "boom",
				stopReason: "error",
			},
		),
		"sidecar typing: retry exhaustion → typed error",
	);
	assert(
		eq(child.parseDeniedTools("a, b,,c"), ["a", "b", "c"]),
		"denied list parses",
	);
	const collapsedStrip = child.identityStripLines({
		label: "scout",
		tools: Array(12).fill("t"),
		denied: Array(4).fill("d"),
	});
	assert(
		eq(collapsedStrip, ["[scout] — 12 tools · 4 denied (Ctrl+H)"]),
		"collapsed strip: [scout] — 12 tools · 4 denied (Ctrl+H)",
	);
	const expanded = child.identityStripLines({
		label: "scout",
		tools: ["read", "bash"],
		denied: ["write"],
		expanded: true,
	});
	assert(
		expanded[0] === "[scout] — 2 tools  (Ctrl+H to collapse)" &&
			expanded.includes("read, bash") &&
			expanded.includes("denied: write"),
		"expanded strip lists tools + denied",
	);
	assert(
		child
			.identityStripLines({ label: "", tools: [], denied: [] })[0]
			.startsWith("[herdr agent] — 0 tools"),
		"anonymous child still labels itself",
	);
}

// ---------------------------------------------------------------------------
console.log("\n[7] Child extension — registration against a mock pi");
{
	const registered = { widgets: {}, shortcuts: [], tools: [], handlers: {} };
	const mockPi = {
		setSessionName: (n) => (registered.sessionName = n),
		getAllTools: () => [{ name: "read" }, { name: "bash" }, { name: "write" }],
		setWidget: (key, lines) => (registered.widgets[key] = lines),
		registerShortcut: (key, opts) => registered.shortcuts.push({ key, opts }),
		registerTool: (t) => registered.tools.push(t),
		on: (ev, h) => (registered.handlers[ev] ??= []).push(h),
	};
	// no env → no-op
	child.registerChildExtension(mockPi);
	assert(
		registered.tools.length === 0 && registered.shortcuts.length === 0,
		"without PI_HERDR_SESSION the extension is a no-op",
	);

	const dir = mkdtempSync(join(tmpdir(), "pi-herdr-child-"));
	const sess = join(dir, "s.jsonl");
	writeFileSync(sess, "");
	process.env.PI_HERDR_SESSION = sess;
	process.env.PI_HERDR_NAME = "scout";
	process.env.PI_HERDR_AGENT = "Explore";
	process.env.PI_HERDR_AUTO_EXIT = "1";
	process.env.PI_HERDR_DENIED_TOOLS = "write,edit";
	process.env.PI_HERDR_ERROR_EXIT_GRACE_MS = "50";
	try {
		child.registerChildExtension(mockPi);
		const ctxMock = {
			ui: { setWidget: (k, lines) => (registered.widgets[k] = lines) },
		};
		await registered.handlers.session_start[0]({}, ctxMock);
		assert(
			registered.sessionName === "herdr/scout",
			"session named herdr/<spawn-name>",
		);
		assert(
			eq(registered.widgets["herdr-identity"], [
				"[Explore] — 3 tools · 2 denied (Ctrl+H)",
			]),
			"identity strip rendered aboveEditor content",
		);
		assert(registered.shortcuts[0]?.key === "ctrl+h", "Ctrl+H toggles the strip");
		const done = registered.tools.find((t) => t.name === "agent_done");
		assert(!!done, "agent_done tool registered");
		const settle = registered.handlers.agent_settled?.[0];
		assert(!!settle, "agent_settled wired (the definitive idle signal)");

		// agent_done: writes {type:"done"} + shuts down
		let shut = 0;
		await done.execute("t1", {}, undefined, undefined, {
			shutdown: () => shut++,
		});
		assert(
			JSON.parse(readFileSync(`${sess}.exit`, "utf8")).type === "done",
			"agent_done wrote the typed done sidecar",
		);
		assert(shut === 1, "agent_done exits the session");

		// auto-exit on settle: agent_end holds messages, settle writes + exits
		shut = 0;
		await registered.handlers.agent_end[0]({
			type: "agent_end",
			messages: [{ role: "assistant", stopReason: "stop" }],
		});
		await settle({}, { shutdown: () => shut++ });
		assert(
			shut === 1 &&
				JSON.parse(readFileSync(`${sess}.exit`, "utf8")).type === "done",
			"autonomous settle → done sidecar + exit",
		);

		// error stop → typed error sidecar, but ONLY after a quiet grace window:
		// pi may be scheduling its next retry (backoff), and exiting on the first
		// error settle would kill the retry machine mid-flight.
		shut = 0;
		await registered.handlers.agent_end[0]({
			type: "agent_end",
			messages: [
				{ role: "assistant", stopReason: "error", errorMessage: "overloaded" },
			],
		});
		await settle({}, { shutdown: () => shut++ });
		const sidecarDuringGrace = JSON.parse(
			readFileSync(`${sess}.exit`, "utf8"),
		);
		assert(
			shut === 0 && sidecarDuringGrace.type === "done",
			"error settle does NOT exit immediately nor overwrite the sidecar (retry grace window)",
		);
		// a new run (pi retrying) within the window cancels the pending exit
		await registered.handlers.agent_start[0]({ type: "agent_start" });
		await sleep(80);
		assert(
			shut === 0,
			"agent_start within the grace window cancels the error exit (retry survives)",
		);

		// retry fails again → fresh window; with the window quiet, the typed
		// failure lands and the child exits
		await registered.handlers.agent_end[0]({
			type: "agent_end",
			messages: [
				{ role: "assistant", stopReason: "error", errorMessage: "overloaded" },
			],
		});
		await settle({}, { shutdown: () => shut++ });
		await sleep(120);
		const side = JSON.parse(readFileSync(`${sess}.exit`, "utf8"));
		assert(
			shut === 1 && side.type === "error" && side.errorMessage === "overloaded",
			"quiet grace window → provider failure reaches the parent as a typed error sidecar",
			);

		// aborted → stays open
		shut = 0;
		await registered.handlers.agent_end[0]({
			type: "agent_end",
			messages: [{ role: "assistant", stopReason: "aborted" }],
		});
		await settle({}, { shutdown: () => shut++ });
		await sleep(80);
		assert(shut === 0, "aborted run does NOT auto-exit");
	} finally {
		delete process.env.PI_HERDR_SESSION;
		delete process.env.PI_HERDR_NAME;
		delete process.env.PI_HERDR_AGENT;
		delete process.env.PI_HERDR_AUTO_EXIT;
		delete process.env.PI_HERDR_DENIED_TOOLS;
		delete process.env.PI_HERDR_ERROR_EXIT_GRACE_MS;
		rmSync(dir, { recursive: true, force: true });
	}

	// interactive stance: never auto-closes
	const dir2 = mkdtempSync(join(tmpdir(), "pi-herdr-child2-"));
	const sess2 = join(dir2, "s.jsonl");
	writeFileSync(sess2, "");
	process.env.PI_HERDR_SESSION = sess2;
	process.env.PI_HERDR_AUTO_EXIT = "0";
	try {
		const pi2 = {
			on: (e, h) => ((pi2.h ??= {})[e] = h),
			registerTool: () => {},
			registerShortcut: () => {},
			setSessionName: () => {},
			getAllTools: () => [],
			setWidget: () => {},
		};
		child.registerChildExtension(pi2);
		let shut = 0;
		await pi2.h.agent_end({
			messages: [{ role: "assistant", stopReason: "stop" }],
		});
		await pi2.h.agent_settled({}, { shutdown: () => shut++ });
		assert(
			shut === 0 && !existsSync(`${sess2}.exit`),
			"interactive children never auto-close nor write a settle sidecar",
		);
	} finally {
		delete process.env.PI_HERDR_SESSION;
		delete process.env.PI_HERDR_AUTO_EXIT;
		rmSync(dir2, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
console.log("\n[8] Launch plan — --session + -e injection and registry growth");
{
	const dir = mkdtempSync(join(tmpdir(), "pi-herdr-plan-"));
	const started = [];
	const deps = {
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
			return { ok: true, data: { agent: { pane_id: "w1:p9" } } };
		},
		boot: async () => ({ ok: true, data: true }),
		submit: async () => ({ ok: true, data: true }),
		status: async () => ({ ok: true, data: "working" }),
		seed: (seededCwd) => {
			started.seedCwd = seededCwd;
			return { path: join(dir, "seeded.jsonl"), dir };
		},
		worktree: async () => ({ ok: true, data: "D:/wt/auto-branch" }),
		childExtension: "/ext/child.ts",
		// Accept-all registry: this suite is about the substrate, not routing —
		// but a model pin must validate against SOME registry to spawn at all.
		registry: {
			find: (p, id) => ({ provider: p, id }),
			hasConfiguredAuth: () => true,
		},
		autodrain: false,
	};
	spawnMod.clearSpawnRegistry();
	const r = await spawnMod.spawnAgent(
		{
			prompt: "task",
			agent: { name: "scout", kind: "pi", exclude_tools: ["write"] },
		},
		deps,
	);
	assert(r.ok, `spawn accepted (${r.ok ? "" : r.error.message})`);
	const rec = spawnMod.spawnRecords().get("scout");
	assert(rec.stance === "autonomous", "stance recorded on the registry");
	assert(rec.sessionPath === join(dir, "seeded.jsonl"), "sessionPath recorded");
	assert(
		rec.activityPath === `${join(dir, "seeded.jsonl")}.activity.json`,
		"activityPath recorded (reserved for 07)",
	);
	const plan = rec.launchPlan ?? [];
	assert(
		eq(plan.slice(0, 4), [
			"--session",
			join(dir, "seeded.jsonl"),
			"-e",
			"/ext/child.ts",
			]) && plan.includes("--append-system-prompt") &&
			eq(plan.slice(-2), ["--exclude-tools", "write"]),
		"launch plan = --session + -e child extension, then identity/mode-hint blocks (multiline → temp file), then the spec's own flags",
	);
	assert(
		eq(started[0].agentArgs, rec.launchPlan),
		"agent start receives the composed launch plan",
	);
	assert(
		started[0].env.PI_HERDR_SESSION === rec.sessionPath &&
			started[0].env.PI_HERDR_NAME === "scout" &&
			started[0].env.PI_HERDR_AGENT === "scout" &&
			started[0].env.PI_HERDR_AUTO_EXIT === "1" &&
			started[0].env.PI_HERDR_DENIED_TOOLS === "write" &&
			started[0].env.PI_HERDR_SPAWN_DEPTH === "2",
		"child env carries the substrate contract (PI_HERDR_*)",
	);
	assert(
		r.data.stance === "autonomous" && r.data.sessionPath === rec.sessionPath,
		"spawn response reports stance + sessionPath",
	);

	// interactive stance + non-pi kind: no session substrate, no auto-exit env
	started.length = 0;
	spawnMod.clearSpawnRegistry();
	await spawnMod.spawnAgent(
		{ prompt: "x", agent: { name: "chat", kind: "pi", interactive: true } },
		deps,
	);
	const rec2 = spawnMod.spawnRecords().get("chat");
	assert(
		rec2.stance === "interactive",
		"interactive stance derived from the definition",
	);
	assert(
		started[0].env.PI_HERDR_AUTO_EXIT === "0",
		"interactive child gets AUTO_EXIT=0 (never auto-closes)",
	);
	spawnMod.clearSpawnRegistry();
	await spawnMod.spawnAgent(
		{ prompt: "x", agent: { name: "cc", kind: "claude", model: "prov/m" } },
		deps,
	);
	const rec3 = spawnMod.spawnRecords().get("cc");
	assert(
		!rec3.sessionPath && eq(rec3.launchPlan, ["--model", "prov/m"]),
		"non-pi kinds: no session substrate, plain argv launch plan",
	);

	// isolated pi spawns seed under the WORKTREE cwd (the final child cwd),
	// not the parent's
	started.length = 0;
	started.seedCwd = undefined;
	spawnMod.clearSpawnRegistry();
	await spawnMod.spawnAgent(
		{ prompt: "x", agent: { name: "iso", kind: "pi" }, isolated: true },
		deps,
	);
	const rec4 = spawnMod.spawnRecords().get("iso");
	assert(
		rec4.sessionPath === join(dir, "seeded.jsonl"),
		"isolated spawn seeds a session",
	);
	assert(
		started.seedCwd === "D:/wt/auto-branch" &&
			started[0].cwd === "D:/wt/auto-branch",
		"isolated spawn seeds under the worktree path, not the parent cwd",
	);
	rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
console.log("\n[9] get_agent_result — engine paths");
{
	const dir = mkdtempSync(join(tmpdir(), "pi-herdr-res-"));
	const sess = join(dir, "s.jsonl");
	const finalMsg = {
		role: "assistant",
		content: [{ type: "text", text: "THE EXACT FINAL MESSAGE" }],
		stopReason: "stop",
	};
	writeFileSync(
		sess,
		[
			JSON.stringify({ type: "session", id: "x" }),
			JSON.stringify({
				type: "message",
				message: { role: "user", content: "go" },
			}),
			JSON.stringify({ type: "message", message: finalMsg }),
		].join("\n"),
	);

	const record = {
		name: "scout",
		kind: "pi",
		type: "Explore",
		prompt: "t",
		agentArgs: [],
		depth: 2,
		isolated: false,
		paneId: "w1:p1",
		spawnedAt: 1,
		startedAt: 2,
		submitted: true,
		sawWorking: true,
		stance: "autonomous",
		sessionPath: sess,
	};
	const reg = new Map([["scout", record]]);
	const deps = {
		registry: () => reg,
		status: async () => ({ ok: true, data: "idle" }),
		extract: (p) => sf.extractSessionResult(p),
		readSidecar: (p) => sf.readExitSidecar(p),
	};

	// settled, no sidecar yet → JSONL extraction (source session-jsonl)
	const v1 = await resultMod.getAgentResult({ target: "scout" }, deps);
	assert(v1.ok && v1.data.status === "done", "settled idle → done");
	assert(
		v1.data.source === "session-jsonl" &&
			v1.data.result === "THE EXACT FINAL MESSAGE",
		"result text extracted EXACTLY from the JSONL",
	);
	assert(
		JSON.stringify(v1.data.message) === JSON.stringify(finalMsg),
		"full message object carried verbatim in details",
	);
	assert(
		v1.data.sessionPath === sess && v1.data.exitPath === `${sess}.exit`,
		"session + sidecar paths in the view",
	);

	// pane gone + sidecar done → still done (auto-exited child)
	deps.status = async () => ({
		ok: false,
		error: { code: "NOT_FOUND", message: "agent_not_found" },
	});
	writeFileSync(`${sess}.exit`, '{"type":"done"}');
	const v2 = await resultMod.getAgentResult({ target: "scout" }, deps);
	assert(
		v2.ok &&
			v2.data.status === "done" &&
			v2.data.result === "THE EXACT FINAL MESSAGE",
		"auto-exited pane: sidecar wins over fleet-gone, result intact",
	);

	// typed error sidecar
	writeFileSync(
		`${sess}.exit`,
		'{"type":"error","stopReason":"error","errorMessage":"overloaded after retries"}',
	);
	const v3 = await resultMod.getAgentResult({ target: "scout" }, deps);
	assert(
		v3.ok &&
			v3.data.status === "error" &&
			v3.data.error.errorMessage === "overloaded after retries" &&
			v3.data.error.stopReason === "error",
		"failing child surfaces as a typed error",
	);

	// no sidecar + pane gone → gone with last-known metadata
	rmSync(`${sess}.exit`, { force: true });
	const v4 = await resultMod.getAgentResult({ target: "scout" }, deps);
	assert(v4.ok && v4.data.status === "gone", "no sidecar + gone pane → gone");
	assert(
		v4.data.lastKnown.name === "scout" && v4.data.lastKnown.sessionPath === sess,
		"gone carries last-known registry metadata (incl. session path)",
	);

	// queued
	record.paneId = undefined;
	const v5 = await resultMod.getAgentResult({ target: "scout" }, deps);
	assert(v5.ok && v5.data.status === "queued", "queued record reports queued");
	record.paneId = "w1:p1";

	// working → interim snapshot from the JSONL (projected vocabulary: the
	// pane is live and working → active; no activity sidecar on disk → coarse)
	deps.status = async () => ({ ok: true, data: "working" });
	const v6 = await resultMod.getAgentResult({ target: "scout" }, deps);
	assert(
		v6.ok &&
			v6.data.status === "active" &&
			v6.data.interim === true &&
			!!v6.data.message,
		"mid-flight snapshot carries the message-so-far, marked interim",
	);

	// mined stopReason=error off the JSONL (no sidecar) when settled
	rmSync(`${sess}.exit`, { force: true });
	const errFinal = {
		role: "assistant",
		content: [{ type: "text", text: "x" }],
		stopReason: "error",
		errorMessage: "429 exhausted",
	};
	writeFileSync(
		sess,
		[
			JSON.stringify({ type: "session", id: "x" }),
			JSON.stringify({ type: "message", message: errFinal }),
		].join("\n"),
	);
	// a LIVE pane whose last attempt failed keeps polling (grace semantics):
	// typed payload attached, and the projected state stays NON-terminal
	// (waiting — herdr sees it settled; the child may still retry) so wait
	// loops ride out the retries
	deps.status = async () => ({ ok: true, data: "idle" });
	const v7 = await resultMod.getAgentResult({ target: "scout" }, deps);
	assert(
		v7.ok &&
			v7.data.status === "waiting" &&
			v7.data.error?.errorMessage === "429 exhausted" &&
			v7.data.interim === true,
		"live pane + failed last attempt: non-terminal waiting with the typed payload (grace semantics)",
	);

	// a DEAD pane whose last word was the failure IS the terminal typed answer
	deps.status = async () => ({
		ok: false,
		error: { code: "NOT_FOUND", message: "agent_not_found" },
	});
	const v7b = await resultMod.getAgentResult({ target: "scout" }, deps);
	assert(
		v7b.ok &&
			v7b.data.status === "error" &&
			v7b.data.error.errorMessage === "429 exhausted" &&
			v7b.data.lastKnown?.name === "scout",
		"dead pane + mined failure → typed error carrying last-known metadata",
	);

	// an INTERACTIVE child's settled error is final (no grace, no sidecar)
	record.stance = "interactive";
	deps.status = async () => ({ ok: true, data: "idle" });
	const v7c = await resultMod.getAgentResult({ target: "scout" }, deps);
	assert(
		v7c.ok &&
			v7c.data.status === "error" &&
			v7c.data.error.errorMessage === "429 exhausted",
		"interactive child + settled error → terminal error (never keeps polling)",
	);
	record.stance = "autonomous";

	// pane-tail fallback for panes we didn't spawn; NOT used for spawned pi children
	let tailCalls = 0;
	const adopted = {
		registry: () => new Map(),
		readTail: async () => {
			tailCalls++;
			return { ok: true, data: { text: "TAIL TEXT", truncated: false } };
		},
	};
	const v8 = await resultMod.getAgentResult({ target: "w1:p77" }, adopted);
	assert(
		v8.ok &&
			v8.data.source === "pane-tail" &&
			v8.data.adopted === true &&
			v8.data.result === "TAIL TEXT",
		"adopted pane: pane-tail fallback reads the tail",
	);
	assert(tailCalls === 1, "tail read used exactly once for the adopted pane");
	// and the pi path never touches the tail:
	deps.readTail = async () => {
		throw new Error("pane-tail must not be consulted for spawned pi children");
	};
	deps.status = async () => ({ ok: true, data: "working" });
	const v9 = await resultMod.getAgentResult({ target: "scout" }, deps);
	assert(
		v9.ok && v9.data.source === "session-jsonl",
		"spawned pi child: JSONL, never pane-tail",
	);

	// a spawned NON-pi kind has no session substrate: the settled result comes
	// from the pane-tail fallback (with the caller's lines budget)
	const claude = {
		...record,
		name: "cc",
		kind: "claude",
		sessionPath: undefined,
	};
	const regCc = new Map([["cc", claude]]);
	let ccLines = 0;
	const ccDeps = {
		registry: () => regCc,
		status: async () => ({ ok: true, data: "idle" }),
		readTail: async (_t, n) => {
			ccLines = n;
			return { ok: true, data: { text: "CLAUDE VERDICT", truncated: false } };
		},
	};
	const v11 = await resultMod.getAgentResult({ target: "cc", lines: 42 }, ccDeps);
	assert(
		v11.ok &&
			v11.data.status === "running" &&
			v11.data.source === "pane-tail" &&
			v11.data.result === "CLAUDE VERDICT" &&
			ccLines === 42,
		"spawned non-pi child: settled result read via the pane-tail fallback with the lines budget",
	);

	// wait loop: bounded expiry + terminal stop
	deps.status = async () => ({ ok: true, data: "working" });
	let polls = 0;
	const waitDeps = {
		...deps,
		status: async () => {
			polls++;
			return polls >= 3
				? { ok: true, data: "idle" }
				: { ok: true, data: "working" };
		},
		now: () => polls * 10,
		sleep: async () => {},
		pollMs: 1,
	};
	writeFileSync(
		sess,
		`${JSON.stringify({ type: "message", message: finalMsg })}\n`,
	);
	const v10 = await resultMod.getAgentResult(
		{ target: "scout", wait: 1000 },
		waitDeps,
	);
	assert(
		v10.ok &&
			v10.data.status === "done" &&
			v10.data.result === "THE EXACT FINAL MESSAGE",
		"bounded wait polls until the terminal state, then returns the result",
	);

	rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
console.log("\n[10] Registration — surface convergence");
{
	const tools = [];
	agentsTool.registerAgents({
		registerTool: (t) => tools.push(t),
		on: () => {},
	});
	resultMod.registerResultTool({
		registerTool: (t) => tools.push(t),
		on: () => {},
	});
	assert(
		tools.some((t) => t.name === "herdr_get_agent_result"),
		"herdr_get_agent_result registered",
	);
	const get = tools.find((t) => t.name === "herdr_get_agent_result");
	assert(
		!!get.parameters.properties.wait && !!get.parameters.properties.target,
		"schema: target + optional bounded wait",
	);
}

console.log(
	`\n${failed === 0 ? "✅ ALL PASS" : "❌ SOME FAILED"} (${passed}/${passed + failed})`,
);
process.exit(failed === 0 ? 0 : 1);
