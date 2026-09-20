// Smoke test for pi-herdr (no live herdr server required).
// Validates: extension load + tool registration (AC1), the version floor
// (v0.6 issue 01: pure classification + the gate inside herdr()),
// herdr() unavailable path (AC5), timeout (AC6), destructive labels (AC7),
// and end-to-end envelope parse / error mapping / raw-text via a node.exe fake.
//
// Run: node tests/smoke.mjs

import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NODE = process.execPath;
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

// ---------------------------------------------------------------------------
console.log("\n[1] Extension load + tool registration (AC1, AC7)");
const ext = await jiti.import(join(ROOT, "src/index.ts"), { parent: ROOT });

const tools = [];
const commands = [];
const events = {};
const busEvents = {};
const mockPi = {
	registerTool: (def) => tools.push(def),
	registerCommand: (name, def) => commands.push({ name, def }),
	on: (ev, handler) => {
		(events[ev] ??= []).push(handler);
	},
	events: {
		on: (channel, handler) => {
			(busEvents[channel] ??= []).push(handler);
			return () => {};
		},
		emit: () => {},
	},
};
await ext.default(mockPi);

const names = tools.map((t) => t.name);
const expected = [
	// the v0.6 surface (issue 02 cut + issue 04 substrate): ONE surface.
	// Later tickets register theirs (05 → message_agent, 10 → interrupt/resume,
	// 12 → run_workflow) and the count converges to 12.
	"herdr_spawn_agent",
	// the `.md` registry persistence tool (issue 03; ungated by decision)
	"herdr_save_agent",
	// the pull/inspection tool (issue 04) — retired wait_agent + read_agent of
	// the legacy result trio
	"herdr_get_agent_result",
	// the open message channel (issue 05) — absorbed send_prompt, the last of
	// the legacy trio
	"herdr_message_agent",
	// the fleet's single introspection tool
	"herdr_list_agents",
	// the pane-sync quartet
	"herdr_run_command",
	"herdr_read_pane",
	"herdr_wait_output",
	"herdr_send_keys",
];
for (const n of expected) assert(names.includes(n), `registered ${n}`);
assert(
	names.length === expected.length,
	`exactly ${expected.length} tools (got ${names.length})`,
);
// Every cut tool is GONE from the model surface (v0.6 issue 02): layout,
// tab/workspace CRUD, worktree CRUD, introspection beyond list_agents, and
// herdr_delegate. Their machinery still runs internally (isolated worktrees,
// the poll loop) — but the LLM must stop seeing these names.
const cut = [
	"herdr_send_prompt",
	"herdr_start_agent",
	"herdr_delegate",
	"herdr_get_agent",
	"herdr_stop_agent",
	"herdr_rename_agent",
	"herdr_focus_agent",
	"herdr_explain_agent",
	"herdr_split_pane",
	"herdr_close_pane",
	"herdr_list_panes",
	"herdr_get_pane",
	"herdr_resize_pane",
	"herdr_zoom_pane",
	"herdr_move_pane",
	"herdr_swap_panes",
	"herdr_list_tabs",
	"herdr_create_tab",
	"herdr_get_tab",
	"herdr_focus_tab",
	"herdr_rename_tab",
	"herdr_close_tab",
	"herdr_list_workspaces",
	"herdr_create_workspace",
	"herdr_get_workspace",
	"herdr_focus_workspace",
	"herdr_rename_workspace",
	"herdr_close_workspace",
	"herdr_worktree_create",
	"herdr_worktree_open",
	"herdr_worktree_list",
	"herdr_worktree_remove",
	"herdr_api_snapshot",
	"herdr_session_list",
	"herdr_session_stop",
	"herdr_session_delete",
];
for (const n of cut)
	assert(!names.includes(n), `${n} absent (cut from the surface)`);
assert(events.agent_start?.length >= 1, "wired agent_start footer hook");
assert(
	commands.some((c) => c.name === "subagents"),
	"registered the /subagents config command",
);
assert(
	!commands.some((c) => c.name === "herdr"),
	"the /herdr command is gone (renamed /subagents)",
);
assert(events.turn_end?.length === 1, "wired turn_end footer hook");
// Self-report (src/selfreport.ts) activates only inside a herdr pane; when it
// does, it adds session_start/agent_start/agent_settled/session_shutdown hooks
// plus rpiv + cursor ask-blocked EventBus subscriptions.
const selfReportActive =
	!!process.env.HERDR_PANE_ID && process.env.HERDR_ENV === "1";
if (selfReportActive) {
	assert(
		(events.session_start?.length ?? 0) >= 1,
		"self-report wired session_start (running inside herdr)",
	);
	assert(
		(events.agent_settled?.length ?? 0) >= 1,
		"self-report wired agent_settled",
	);
	assert(
		(busEvents["herdr:blocked"]?.length ?? 0) >= 1,
		"self-report wired herdr:blocked (current pi-ask-user + pi-subagents channel)",
	);
	assert(
		(busEvents["rpiv:ask-user:blocked"]?.length ?? 0) >= 1,
		"self-report wired rpiv:ask-user:blocked (legacy)",
	);
	assert(
		(busEvents["pi-cursor-sdk:ask-question:blocked"]?.length ?? 0) >= 1,
		"self-report wired pi-cursor-sdk:ask-question:blocked",
	);
}

// Offline: ask-blocked payload → herdr state mapping (no herdr required).
const selfreport = await jiti.import(join(ROOT, "src/selfreport.ts"), {
	parent: ROOT,
});
assert(
	selfreport.mapAskUserBlockedToState({ active: true }) === "blocked",
	"ask-user blocked active:true → blocked",
);
assert(
	selfreport.mapAskUserBlockedToState({ active: false }) === "working",
	"ask-user blocked active:false → working (turn resumes)",
);
assert(
	selfreport.mapAskUserBlockedToState({}) === null,
	"ask-user blocked ignores malformed payload",
);
assert(
	selfreport.HERDR_BLOCKED_EVENT === "herdr:blocked",
	"herdr:blocked channel matches current pi-ask-user contract",
);
assert(
	selfreport.ASK_USER_BLOCKED_EVENT === "rpiv:ask-user:blocked",
	"ask-user blocked channel matches legacy rpiv contract",
);
assert(
	selfreport.CURSOR_ASK_QUESTION_BLOCKED_EVENT ===
		"pi-cursor-sdk:ask-question:blocked",
	"cursor ask-question blocked channel matches pi-cursor-sdk contract",
);

// AC7: destructive tools labeled
const sendKeysTool = tools.find((t) => t.name === "herdr_send_keys");
assert(
	/⚠️/.test(sendKeysTool.description),
	"herdr_send_keys description carries ⚠️ (AC7: ctrl+c interrupts a process)",
);
for (const t of tools) {
	assert(typeof t.parameters === "object", `${t.name} has parameters schema`);
	assert(typeof t.execute === "function", `${t.name} has execute()`);
}

// ---------------------------------------------------------------------------
console.log("\n[2] Version floor: pure classification (v0.6 issue 01)");
const versionMod = await jiti.import(join(ROOT, "src/version.ts"), {
	parent: ROOT,
});
assert(
	eq(versionMod.parseVersion("herdr 0.9.0"), { major: 0, minor: 9, patch: 0 }),
	"parseVersion('herdr 0.9.0') -> {0,9,0}",
);
assert(
	eq(versionMod.parseVersion("herdr 0.7.3-preview"), {
		major: 0,
		minor: 7,
		patch: 3,
	}),
	"parseVersion tolerates pre-release suffix (0.7.3-preview)",
);
assert(
	versionMod.parseVersion("garbage") === null,
	"parseVersion -> null on garbage",
);
assert(versionMod.parseVersion("") === null, "parseVersion -> null on empty");
assert(
	eq(versionMod.MIN_HERDR_VERSION, { major: 0, minor: 9, patch: 0 }),
	"MIN_HERDR_VERSION is 0.9.0",
);
// isAtLeast: the floor comparison (patch ignored).
assert(
	versionMod.isAtLeast({ major: 0, minor: 9, patch: 0 }, 0, 9) === true,
	"0.9.0 -> at least 0.9",
);
assert(
	versionMod.isAtLeast({ major: 0, minor: 9, patch: 5 }, 0, 9) === true,
	"0.9.5 -> at least 0.9 (patch ignored)",
);
assert(
	versionMod.isAtLeast({ major: 1, minor: 0, patch: 0 }, 0, 9) === true,
	"1.0.0 -> at least 0.9",
);
assert(
	versionMod.isAtLeast({ major: 0, minor: 8, patch: 9 }, 0, 9) === false,
	"0.8.9 -> below 0.9",
);
assert(
	versionMod.isAtLeast(null, 0, 9) === false,
	"null version -> below (safe refusal)",
);
// floorError: at/above the floor -> null (run normally).
assert(
	versionMod.floorError({
		state: "ok",
		version: { major: 0, minor: 9, patch: 0 },
	}) === null,
	"floorError: 0.9.0 (at the floor) -> null",
);
assert(
	versionMod.floorError({
		state: "ok",
		version: { major: 0, minor: 10, patch: 1 },
	}) === null,
	"floorError: 0.10.1 -> null",
);
// floorError: below the floor -> one HERDR_TOO_OLD naming version + pointer.
for (const old of [
	{ major: 0, minor: 7, patch: 3 },
	{ major: 0, minor: 7, patch: 5 },
	{ major: 0, minor: 8, patch: 9 },
]) {
	const e = versionMod.floorError({ state: "ok", version: old });
	assert(
		e !== null &&
			e.error.code === "HERDR_TOO_OLD" &&
			new RegExp(`${old.major}.${old.minor}.${old.patch}`).test(e.error.message) &&
			/herdr\.dev/.test(e.error.message) &&
			/>= 0\.9\.0/.test(e.error.message),
		`floorError: ${versionMod.formatVersion(old)} -> HERDR_TOO_OLD naming version + upgrade pointer`,
	);
}
// floorError: unverifiable -> refused (a hard floor doesn't guess).
const unknownFloor = versionMod.floorError({ state: "unknown" });
assert(
	unknownFloor !== null &&
		unknownFloor.error.code === "HERDR_TOO_OLD" &&
		/could not be determined/.test(unknownFloor.error.message),
	"floorError: unknown version -> HERDR_TOO_OLD (refuses rather than guess)",
);
// floorError: missing -> null — the binary won't spawn anyway, so the natural
// HERDR_UNAVAILABLE stays the single clean error (not two stacked errors).
assert(
	versionMod.floorError({ state: "missing" }) === null,
	"floorError: missing binary -> null (natural HERDR_UNAVAILABLE, one error)",
);

// ---------------------------------------------------------------------------
console.log("\n[3] herdr() unavailable path (AC5)");
const herdrMod = await jiti.import(join(ROOT, "src/herdr.ts"), {
	parent: ROOT,
});
process.env.HERDR_BIN = "Z:\\nonexistent\\herdr-binary.exe";
const unavailable = await herdrMod.herdr(["agent", "list"], {
	timeoutMs: 3_000,
});
assert(
	!unavailable.ok && unavailable.error.code === "HERDR_UNAVAILABLE",
	"missing binary -> HERDR_UNAVAILABLE, no throw/hang (AC5)",
);

// ---------------------------------------------------------------------------
console.log("\n[4] herdr() envelope parse + error mapping + raw text");
// Use node.exe (native, shell:false-safe) as a fake herdr via -e scripts.
process.env.HERDR_BIN = NODE;

const okOut = await herdrMod.herdr(
	[
		"-e",
		'console.log(JSON.stringify({id:"x",result:{agents:[],type:"agent_list"}}))',
	],
	{ timeoutMs: 5_000 },
);
assert(
	okOut.ok && eq(okOut.data, { agents: [], type: "agent_list" }),
	"parses success envelope -> result",
);

const errOut = await herdrMod.herdr(
	[
		"-e",
		'console.log(JSON.stringify({error:{code:"agent_start_failed",message:"boom"},id:"x"}))',
	],
	{ timeoutMs: 5_000 },
);
assert(
	!errOut.ok &&
		errOut.error.code === "AGENT_START_FAILED" &&
		errOut.error.message === "boom",
	`maps agent_start_failed -> AGENT_START_FAILED (got ${errOut.error?.code})`,
);
// herdr 0.7.5+ emits error envelopes on stderr (stdout empty, exit 1).
const stderrErr = await herdrMod.herdr(
	[
		"-e",
		'process.stderr.write(JSON.stringify({error:{code:"agent_start_failed",message:"boom2"},id:"x"}));process.exit(1)',
	],
	{ timeoutMs: 5_000 },
);
assert(
	!stderrErr.ok &&
		stderrErr.error.code === "AGENT_START_FAILED" &&
		stderrErr.error.message === "boom2" &&
		stderrErr.error.details?.code === "agent_start_failed",
	"parses stderr error envelope -> mapped code + details.code (0.7.5 emits errors on stderr)",
);

const rawOut = await herdrMod.herdr(["-e", 'process.stdout.write("pong\\n")'], {
	timeoutMs: 5_000,
	textOk: true,
});
assert(
	rawOut.ok && rawOut.data === "pong\n",
	"textOk returns raw stdout as data",
);

// ---------------------------------------------------------------------------
console.log("\n[5] herdr() timeout (AC6)");
const t0 = Date.now();
const timeoutOut = await herdrMod.herdr(["-e", "setInterval(()=>{},60000)"], {
	timeoutMs: 1_200,
});
const elapsed = Date.now() - t0;
assert(
	!timeoutOut.ok && timeoutOut.error.code === "TIMEOUT",
	`hanging process -> TIMEOUT after ~${elapsed}ms (AC6)`,
);
assert(elapsed < 4_000, "timeout fires promptly (no hang)");

// ---------------------------------------------------------------------------
console.log("\n[6] Real herdr binary: parse real JSON output");
delete process.env.HERDR_BIN;
const cfg = await jiti.import(join(ROOT, "src/config.ts"), { parent: ROOT });
process.env.HERDR_BIN = cfg.resolveHerdrBin();
const schemaOut = await herdrMod.herdr(["api", "schema", "--json"], {
	timeoutMs: 10_000,
});
assert(
	schemaOut.ok && typeof schemaOut.data === "object" && schemaOut.data?.schemas,
	"real herdr.exe 'api schema --json' parsed as JSON (validates native spawn + parse)",
);

// ---------------------------------------------------------------------------
console.log(
	"\n[7] Version probe + floor gate (e2e, node fake — v0.6 issue 01)",
);
// probe state machine: "ok" when herdr runs, "missing" when the binary is
// absent. Use node as a fake herdr (its --version prints "vMAJOR.MINOR.PATCH").
process.env.HERDR_BIN = NODE;
const okProbe = await herdrMod.refreshHerdrProbe();
assert(
	okProbe.state === "ok" && typeof okProbe.version?.major === "number",
	"probe -> ok when herdr runs (spawns + parses --version, e2e)",
);
assert(
	typeof versionMod.formatVersion(okProbe.version) === "string",
	"formatVersion returns a string",
);
process.env.HERDR_BIN = "Z:\\nonexistent\\herdr-binary.exe";
const missingProbe = await herdrMod.refreshHerdrProbe();
assert(
	missingProbe.state === "missing",
	"probe -> missing when herdr binary absent",
);
// The GATE: every herdr() call is refused below the floor — the call below
// would "work" (node fake prints a valid envelope) but must not run at all.
process.env.HERDR_BIN = NODE;
herdrMod.setProbeForTests({
	state: "ok",
	version: { major: 0, minor: 8, patch: 2 },
});
const refused = await herdrMod.herdr(
	["-e", 'console.log(JSON.stringify({result:{agents:[]},id:"x"}))'],
	{ timeoutMs: 5_000 },
);
assert(
	!refused.ok &&
		refused.error.code === "HERDR_TOO_OLD" &&
		/0\.8\.2 is too old/.test(refused.error.message) &&
		/herdr\.dev/.test(refused.error.message),
	"below floor -> HERDR_TOO_OLD naming the version + upgrade pointer",
);
const refusedList = await herdrMod.herdr(["agent", "list"], {
	timeoutMs: 5_000,
});
assert(
	refusedList.error.code === "HERDR_TOO_OLD",
	"every call refused below the floor (no tool half-works)",
);
// Unverifiable version -> refused too (a hard floor does not guess).
herdrMod.setProbeForTests({ state: "unknown" });
const unknownRefused = await herdrMod.herdr(["agent", "list"], {
	timeoutMs: 5_000,
});
assert(
	unknownRefused.error.code === "HERDR_TOO_OLD" &&
		/could not be determined/.test(unknownRefused.error.message),
	"unparseable version -> HERDR_TOO_OLD",
);
// Missing binary -> NOT gated: the natural HERDR_UNAVAILABLE stays the error.
herdrMod.setProbeForTests({ state: "missing" });
process.env.HERDR_BIN = "Z:\\nonexistent\\herdr-binary.exe";
const missingCall = await herdrMod.herdr(["agent", "list"], {
	timeoutMs: 3_000,
});
assert(
	!missingCall.ok && missingCall.error.code === "HERDR_UNAVAILABLE",
	"missing binary -> HERDR_UNAVAILABLE (single clean error, no double-up)",
);
// At the floor -> the call proceeds through the single exec path.
herdrMod.setProbeForTests({
	state: "ok",
	version: { major: 0, minor: 9, patch: 0 },
});
process.env.HERDR_BIN = NODE;
const passThrough = await herdrMod.herdr(
	["-e", 'console.log(JSON.stringify({result:{agents:[]},id:"x"}))'],
	{ timeoutMs: 5_000 },
);
assert(
	passThrough.ok && eq(passThrough.data, { agents: [] }),
	"at floor (0.9.0) -> call proceeds through the single exec path",
);
// restore a cold probe cache for later sections
herdrMod.setProbeForTests(null);
// ---------------------------------------------------------------------------
console.log(
	"\n[8] herdr_spawn_agent exposes agent_args (the local-ext loader)",
);
const spawnAgentTool = tools.find((t) => t.name === "herdr_spawn_agent");
assert(!!spawnAgentTool, "herdr_spawn_agent registered");
assert(
	!!spawnAgentTool?.parameters?.properties?.agent?.properties?.agent_args,
	"herdr_spawn_agent's inline agent exposes agent_args",
);
assert(
	!spawnAgentTool?.parameters?.properties?.argv,
	"herdr_spawn_agent exposes no raw argv (dropped custom-argv surface)",
);

// ---------------------------------------------------------------------------
console.log(
	"\n[9] herdr_wait_agent argv — 'agent wait --until' (the one wait path)",
);
const orchMod = await jiti.import(join(ROOT, "src/tools/orchestration.ts"), {
	parent: ROOT,
});
assert(
	typeof orchMod.transitionWaitArgs === "function",
	"transitionWaitArgs exported from orchestration",
);
assert(
	eq(orchMod.transitionWaitArgs("w1:p2", ["idle"], 60000), [
		"agent",
		"wait",
		"w1:p2",
		"--until",
		"idle",
		"--timeout",
		"60000",
	]),
	"single status -> 'agent wait --until'",
);
assert(
	eq(orchMod.transitionWaitArgs("w1:p2", ["idle", "done"], 90000), [
		"agent",
		"wait",
		"w1:p2",
		"--until",
		"idle",
		"--until",
		"done",
		"--timeout",
		"90000",
	]),
	"multi-status -> one call with repeatable --until (idle+done raced together)",
);
assert(
	eq(orchMod.transitionWaitArgs("w1:p2", ["working"], 30000), [
		"agent",
		"wait",
		"w1:p2",
		"--until",
		"working",
		"--timeout",
		"30000",
	]),
	"working/blocked/unknown -> the same 'agent wait --until' path (no version branch)",
);

// ---------------------------------------------------------------------------
console.log("\n[10] herdr_delegate submit+wait argv ('agent prompt --wait')");
assert(
	typeof orchMod.promptWaitArgs === "function",
	"promptWaitArgs exported from orchestration",
);
// Atomic submit + settled wait in ONE call.
assert(
	eq(orchMod.promptWaitArgs("w1:p2", "ping", 30000), [
		"agent",
		"prompt",
		"w1:p2",
		"ping",
		"--wait",
		"--timeout",
		"30000",
	]),
	"one 'agent prompt <target> <text> --wait --timeout <ms>' call",
);
assert(
	eq(orchMod.promptWaitArgs("w1:p2", "hello world", 120000), [
		"agent",
		"prompt",
		"w1:p2",
		"hello world",
		"--wait",
		"--timeout",
		"120000",
	]),
	"prompt text with spaces stays a single positional argv element",
);
assert(
	typeof orchMod.promptWaitArgs("w1:p2", "x", 1)[6] === "string",
	"--timeout is stringified (spawn argv must be strings)",
);

// ---------------------------------------------------------------------------
console.log(
	"\n[11] T3: drop custom/argv; validate agent kind against live list",
);
const configMod = await jiti.import(join(ROOT, "src/config.ts"), {
	parent: ROOT,
});
// parseAgentKinds pulls the trailing `kinds: a|b|c` line from `herdr agent`.
assert(
	eq(
		configMod.parseAgentKinds(
			"herdr agent commands:\n  herdr agent start <name> --kind KIND --pane ID\n  kinds: pi|claude|codex|omp",
		),
		["pi", "claude", "codex", "omp"],
	),
	"parseAgentKinds parses the trailing `kinds: a|b|c` line (lowercased)",
);
assert(
	configMod.parseAgentKinds("no kinds line here") === null,
	"parseAgentKinds -> null when no kinds line",
);
assert(
	Array.isArray(configMod.AGENT_KINDS_FALLBACK) &&
		configMod.AGENT_KINDS_FALLBACK.includes("pi") &&
		configMod.AGENT_KINDS_FALLBACK.length >= 10,
	"AGENT_KINDS_FALLBACK is a non-trivial hardcoded list",
);
// getAgentKinds falls back to the hardcoded list when herdr is unavailable, and
// caches the result per session (same reference on the 2nd call, no re-fetch).
configMod.resetAgentKindsCache();
process.env.HERDR_BIN = "Z:\\nonexistent\\herdr-binary.exe";
const fbKinds = await configMod.getAgentKinds();
assert(
	Array.isArray(fbKinds) && eq(fbKinds, [...configMod.AGENT_KINDS_FALLBACK]),
	"getAgentKinds falls back to AGENT_KINDS_FALLBACK when herdr unavailable",
);
assert(
	(await configMod.getAgentKinds()) === fbKinds,
	"getAgentKinds caches per session (same array reference on 2nd call)",
);
configMod.resetAgentKindsCache();
delete process.env.HERDR_BIN;

// kindError: the pure, offline-testable unknown-kind error path.
assert(
	orchMod.kindError("pi", ["pi", "claude"]) === null,
	"kindError: known kind -> null (valid)",
);
assert(
	orchMod.kindError("PI", ["pi", "claude"]) === null,
	"kindError: case-insensitive (PI == pi)",
);
const badKind = orchMod.kindError("nope", ["pi", "claude"]);
assert(
	badKind !== null &&
		badKind.error.code === "VALIDATION_ERROR" &&
		/pi, claude/.test(badKind.error.message),
	"kindError: unknown kind -> VALIDATION_ERROR listing valid kinds",
);

// The spawn surface's `agent.kind` is a free string validated against the
// live list at execute time (kindError above); no stale enum in the schema.
assert(
	spawnAgentTool?.parameters?.properties?.agent?.properties?.kind?.type ===
		"string",
	"herdr_spawn_agent's inline agent.kind is a free string (live-validated)",
);

// ---------------------------------------------------------------------------
console.log("\n[12] pane-sync quartet (run/read/wait_output/send_keys)");
const syncMod = await jiti.import(join(ROOT, "src/tools/sync.ts"), {
	parent: ROOT,
});
assert(
	typeof syncMod.waitOutputArgs === "function",
	"waitOutputArgs exported from sync (pure argv builder, offline-testable)",
);
const paneTools = [
	"herdr_run_command",
	"herdr_read_pane",
	"herdr_wait_output",
	"herdr_send_keys",
];
for (const n of paneTools) assert(names.includes(n), `registered ${n}`);
// Each kept tool has the documented LLM hints (CONTRIBUTING: promptSnippet + guidelines).
for (const n of paneTools) {
	const t = tools.find((x) => x.name === n);
	assert(!!t?.promptSnippet, `${n} has promptSnippet`);
	assert(
		Array.isArray(t?.promptGuidelines) && t.promptGuidelines.length > 0,
		`${n} has promptGuidelines`,
	);
	assert(
		/run_command|read_pane|wait_output|send_keys/.test(
			t.promptGuidelines.join(" "),
		),
		`${n} promptGuidelines name the tool`,
	);
}
// waitOutputArgs: match path (default timeout always emitted — no indefinite hang).
assert(
	eq(syncMod.waitOutputArgs("w1:p3", { match: "ready" }), [
		"pane",
		"wait-output",
		"w1:p3",
		"--match",
		"ready",
		"--timeout",
		"30000",
	]),
	"waitOutputArgs: --match path with default 30s timeout",
);
// waitOutputArgs: regex path + optional flags.
assert(
	eq(
		syncMod.waitOutputArgs("w1:p3", {
			regex: "\\d+ ready",
			source: "visible",
			lines: 10,
			timeoutMs: 5000,
			raw: true,
		}),
		[
			"pane",
			"wait-output",
			"w1:p3",
			"--regex",
			"\\d+ ready",
			"--source",
			"visible",
			"--lines",
			"10",
			"--timeout",
			"5000",
			"--raw",
		],
	),
	"waitOutputArgs: --regex path with source/lines/timeout/raw",
);
assert(
	typeof syncMod.waitOutputArgs("w1:p3", { match: "x" })[6] === "string",
	"waitOutputArgs: --timeout is stringified (spawn argv must be strings)",
);
// herdr_run_command takes a single command string (validated e2e launch path).
assert(
	!!tools.find((t) => t.name === "herdr_run_command")?.parameters?.properties
		?.command,
	"herdr_run_command exposes a 'command' string param",
);
// AC7: the one destructive pane tool left on the surface is labeled ⚠️.
const sendKeys = tools.find((t) => t.name === "herdr_send_keys");
assert(
	/⚠️/.test(sendKeys.description),
	"herdr_send_keys description carries ⚠️ (AC7: ctrl+c interrupts a process)",
);
// send_keys exposes agentScope (switches pane vs agent send-keys surface).
assert(
	!!sendKeys?.parameters?.properties?.agentScope,
	"herdr_send_keys exposes agentScope (pane send-keys vs agent send-keys)",
);

// ---------------------------------------------------------------------------
console.log("\n[13] Worktree machinery survives the cut (powers `isolated`)");
const worktreesMod = await jiti.import(join(ROOT, "src/tools/worktrees.ts"), {
	parent: ROOT,
});
// The CRUD tools are gone (asserted in [1]); the machinery is not.
assert(
	typeof worktreesMod.registerWorktrees === "undefined",
	"worktrees registers no tools (registerWorktrees deleted with the surface cut)",
);
assert(
	typeof worktreesMod.createWorktreeArgs === "function",
	"createWorktreeArgs exported from worktrees (pure argv builder)",
);
// create serializes workspace/cwd/branch/base/path/label/focus and always emits --json.
assert(
	eq(
		worktreesMod.createWorktreeArgs({
			workspaceId: "w2",
			cwd: "/repo",
			branch: "feat",
			base: "main",
			path: "/wt/feat",
			label: "feat-wt",
			focus: true,
		}),
		[
			"worktree",
			"create",
			"--workspace",
			"w2",
			"--cwd",
			"/repo",
			"--branch",
			"feat",
			"--base",
			"main",
			"--path",
			"/wt/feat",
			"--label",
			"feat-wt",
			"--focus",
			"--json",
		],
	),
	"createWorktreeArgs: full option set serializes in documented flag order with --json",
);
assert(
	eq(worktreesMod.createWorktreeArgs({ focus: false }), [
		"worktree",
		"create",
		"--no-focus",
		"--json",
	]),
	"createWorktreeArgs: focus:false -> --no-focus; undefined options omitted; --json always present",
);
// remove: workspace/force optional, --json always (the teardown path).
assert(
	eq(worktreesMod.removeWorktreeArgs({}), ["worktree", "remove", "--json"]),
	"removeWorktreeArgs: bare 'worktree remove --json'",
);
assert(
	eq(worktreesMod.removeWorktreeArgs({ workspaceId: "w2", force: true }), [
		"worktree",
		"remove",
		"--workspace",
		"w2",
		"--force",
		"--json",
	]),
	"removeWorktreeArgs: --workspace + --force",
);
// normalizer tolerates snake_case + open_workspace_id alias.
assert(
	eq(
		worktreesMod.normalizeWorktree({
			path: "D:/r",
			branch: "main",
			open_workspace_id: "w1",
			is_linked_worktree: false,
		}),
		{
			path: "D:/r",
			branch: "main",
			label: undefined,
			openWorkspaceId: "w1",
			isLinkedWorktree: false,
			isDetached: undefined,
			isBare: undefined,
			isPrunable: undefined,
		},
	),
	"normalizeWorktree maps snake_case -> camelCase (open_workspace_id)",
);
// extractWorktree pulls the first worktree out of a `worktrees` array, and
// falls back to a bare object / `worktree` wrapper.
assert(
	worktreesMod.extractWorktree({ worktrees: [{ path: "/a", branch: "x" }] })
		.path === "/a",
	"extractWorktree: unwraps the first element of a worktrees array",
);
assert(
	worktreesMod.extractWorktree({ worktree: { path: "/b" } }).path === "/b",
	"extractWorktree: unwraps a `worktree` wrapper",
);
assert(
	worktreesMod.extractWorktree({ path: "/c", branch: "y" }).path === "/c",
	"extractWorktree: returns a bare worktree object as-is",
);
// The deleted tool modules are gone from src entirely (no internal consumer
// kept them alive — unlike worktrees, whose machinery `isolated` still uses).
import { existsSync } from "node:fs";
assert(
	!existsSync(join(ROOT, "src/tools/layout.ts")),
	"src/tools/layout.ts deleted (no internal consumer)",
);
assert(
	!existsSync(join(ROOT, "src/tools/introspection.ts")),
	"src/tools/introspection.ts deleted (no internal consumer)",
);

// ---------------------------------------------------------------------------
console.log(
	`\n${failed === 0 ? "✅ ALL PASS" : "❌ SOME FAILED"} (${passed} passed, ${failed} failed)`,
);
process.exit(failed === 0 ? 0 : 1);
