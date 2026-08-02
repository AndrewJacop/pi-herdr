// Smoke test for pi-herdr (no live herdr server required).
// Validates: extension load + tool registration (AC1), launcher argv (AC4),
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
const events = {};
const busEvents = {};
const mockPi = {
	registerTool: (def) => tools.push(def),
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
	"herdr_start_agent",
	"herdr_send_prompt",
	"herdr_read_agent",
	"herdr_wait_agent",
	"herdr_list_agents",
	"herdr_get_agent",
	"herdr_stop_agent",
	"herdr_rename_agent",
	"herdr_focus_agent",
	"herdr_explain_agent",
	"herdr_delegate",
	// Tier 3 — pane-sync (T4)
	"herdr_split_pane",
	"herdr_run_command",
	"herdr_read_pane",
	"herdr_wait_output",
	"herdr_send_keys",
	"herdr_close_pane",
];
for (const n of expected) assert(names.includes(n), `registered ${n}`);
assert(
	names.length === expected.length,
	`exactly ${expected.length} tools (got ${names.length})`,
);
assert(events.agent_start?.length >= 1, "wired agent_start footer hook");
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
		(busEvents["rpiv:ask-user:blocked"]?.length ?? 0) >= 1,
		"self-report wired rpiv:ask-user:blocked",
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
	selfreport.ASK_USER_BLOCKED_EVENT === "rpiv:ask-user:blocked",
	"ask-user blocked channel matches rpiv contract",
);
assert(
	selfreport.CURSOR_ASK_QUESTION_BLOCKED_EVENT ===
		"pi-cursor-sdk:ask-question:blocked",
	"cursor ask-question blocked channel matches pi-cursor-sdk contract",
);

// AC7: destructive tools labeled
const stop = tools.find((t) => t.name === "herdr_stop_agent");
assert(
	/⚠️/.test(stop.description),
	"herdr_stop_agent description carries ⚠️ (AC7)",
);
for (const t of tools) {
	assert(typeof t.parameters === "object", `${t.name} has parameters schema`);
	assert(typeof t.execute === "function", `${t.name} has execute()`);
}

// ---------------------------------------------------------------------------
console.log("\n[2] Launcher preset -> argv (AC4)");
const launcher = await jiti.import(join(ROOT, "src/launcher.ts"), {
	parent: ROOT,
});
const isWin = process.platform === "win32";
const piSpec = launcher.expandAgentSpec({ agent: "pi" });
assert(piSpec.ok, "expandAgentSpec(pi) ok");
assert(
	eq(piSpec.data, isWin ? ["cmd", "/c", "pi"] : ["pi"]),
	`pi argv correct for platform (got ${JSON.stringify(piSpec.data)}) (AC4)`,
);
const custom = launcher.expandAgentSpec({ argv: ["my", "agent"] });
assert(eq(custom.data, ["my", "agent"]), "explicit argv overrides preset");
const bad = launcher.expandAgentSpec({ agent: "nope" });
assert(
	!bad.ok && bad.error.code === "VALIDATION_ERROR",
	"unknown preset -> VALIDATION_ERROR",
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
console.log("\n[7] Version detection + agent-start API boundary (issue #2)");
const versionMod = await jiti.import(join(ROOT, "src/version.ts"), {
	parent: ROOT,
});
assert(
	eq(versionMod.parseVersion("herdr 0.7.5"), { major: 0, minor: 7, patch: 5 }),
	"parseVersion('herdr 0.7.5') -> {0,7,5}",
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
// Legacy API (<0.7.5): one `agent start` creates the pane.
assert(
	versionMod.isNewAgentApi({ major: 0, minor: 7, patch: 2 }) === false,
	"0.7.2 -> legacy",
);
assert(
	versionMod.isNewAgentApi({ major: 0, minor: 7, patch: 3 }) === false,
	"0.7.3 -> legacy (Windows stable)",
);
assert(
	versionMod.isNewAgentApi({ major: 0, minor: 7, patch: 4 }) === false,
	"0.7.4 -> legacy",
);
// Redesigned API (>=0.7.5): needs pane split + --kind/--pane.
assert(
	versionMod.isNewAgentApi({ major: 0, minor: 7, patch: 5 }) === true,
	"0.7.5 -> new API",
);
assert(
	versionMod.isNewAgentApi({ major: 0, minor: 7, patch: 10 }) === true,
	"0.7.10 -> new API",
);
assert(
	versionMod.isNewAgentApi({ major: 0, minor: 8, patch: 0 }) === true,
	"0.8.0 -> new API",
);
assert(
	versionMod.isNewAgentApi({ major: 1, minor: 0, patch: 0 }) === true,
	"1.0.0 -> new API",
);
assert(
	versionMod.isNewAgentApi(null) === false,
	"unknown version -> legacy (safe default)",
);
// e2e: detectHerdrVersion spawns `herdr --version` and parses it. Use node as a
// fake herdr (its --version prints "vMAJOR.MINOR.PATCH" -> major >= 1 -> new API).
process.env.HERDR_BIN = NODE;
const detected = await versionMod.detectHerdrVersion();
assert(
	detected &&
		typeof detected.major === "number" &&
		typeof detected.minor === "number" &&
		typeof detected.patch === "number",
	"detectHerdrVersion spawns + parses --version (e2e)",
);
assert(
	versionMod.isNewAgentApi(detected) === true,
	"detectHerdrVersion result classified (node fake -> new API)",
);
// probe state machine: "ok" when herdr runs, "missing" when the binary is absent.
process.env.HERDR_BIN = NODE;
const okProbe = await versionMod.refreshHerdrProbe();
assert(
	okProbe.state === "ok" && typeof okProbe.version?.major === "number",
	"probe -> ok when herdr runs",
);
assert(
	typeof versionMod.formatVersion(okProbe.version) === "string",
	"formatVersion returns a string",
);
process.env.HERDR_BIN = "Z:\\nonexistent\\herdr-binary.exe";
const missingProbe = await versionMod.refreshHerdrProbe();
assert(
	missingProbe.state === "missing",
	"probe -> missing when herdr binary absent",
);

// ---------------------------------------------------------------------------
console.log("\n[8] agentArgs param exposed on start/delegate tools (v0.2.4)");
const startTool = tools.find((t) => t.name === "herdr_start_agent");
const delegateTool = tools.find((t) => t.name === "herdr_delegate");
assert(!!startTool, "herdr_start_agent registered");
assert(!!delegateTool, "herdr_delegate registered");
assert(
	!!startTool?.parameters?.properties?.agentArgs,
	"herdr_start_agent exposes agentArgs param",
);
assert(
	!!delegateTool?.parameters?.properties?.agentArgs,
	"herdr_delegate exposes agentArgs param",
);

// ---------------------------------------------------------------------------
console.log(
	"\n[9] herdr_wait_agent argv branches on herdr version (T1: 'agent wait --until' on 0.7.5)",
);
const orchMod = await jiti.import(join(ROOT, "src/tools/orchestration.ts"), {
	parent: ROOT,
});
assert(
	typeof orchMod.transitionWaitArgs === "function",
	"transitionWaitArgs exported from orchestration",
);
// New API (>=0.7.5): one `agent wait` per call, `--until` is repeatable.
assert(
	eq(
		orchMod.transitionWaitArgs("w1:p2", ["idle"], 60000, true),
		["agent", "wait", "w1:p2", "--until", "idle", "--timeout", "60000"],
	),
	"new API single status -> 'agent wait --until' (was 'wait agent-status', removed on 0.7.5)",
);
assert(
	eq(
		orchMod.transitionWaitArgs("w1:p2", ["idle", "done"], 90000, true),
		[
			"agent",
			"wait",
			"w1:p2",
			"--until",
			"idle",
			"--until",
			"done",
			"--timeout",
			"90000",
		],
	),
	"new API multi-status -> one call with repeatable --until (idle+done raced together)",
);
assert(
	eq(
		orchMod.transitionWaitArgs("w1:p2", ["working"], 30000, true),
		["agent", "wait", "w1:p2", "--until", "working", "--timeout", "30000"],
	),
	"new API working/blocked/unknown -> 'agent wait --until' (the previously-broken branch)",
);
// Legacy (<0.7.5): keep `wait agent-status` unchanged.
assert(
	eq(
		orchMod.transitionWaitArgs("w1:p2", ["idle"], 60000, false),
		["wait", "agent-status", "w1:p2", "--status", "idle", "--timeout", "60000"],
	),
	"legacy keeps 'wait agent-status'",
);

// ---------------------------------------------------------------------------
console.log(
	"\n[10] herdr_delegate submit+wait argv on herdr 0.7.5 (T2: 'agent prompt --wait')",
);
assert(
	typeof orchMod.promptWaitArgs === "function",
	"promptWaitArgs exported from orchestration",
);
// New API (>=0.7.5): atomic submit + settled wait in ONE call.
assert(
	eq(
		orchMod.promptWaitArgs("w1:p2", "ping", 30000),
		["agent", "prompt", "w1:p2", "ping", "--wait", "--timeout", "30000"],
	),
	"new API -> one 'agent prompt <target> <text> --wait --timeout <ms>' (replaces send → wait dance)",
);
assert(
	eq(
		orchMod.promptWaitArgs("w1:p2", "hello world", 120000),
		[
			"agent",
			"prompt",
			"w1:p2",
			"hello world",
			"--wait",
			"--timeout",
			"120000",
		],
	),
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
	Array.isArray(fbKinds) &&
		eq(fbKinds, [...configMod.AGENT_KINDS_FALLBACK]),
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

// argv dropped from the LLM schema; `agent` is now a free string validated
// against the live list (the stale 4/5-kind enum is gone).
assert(
	!startTool?.parameters?.properties?.argv,
	"herdr_start_agent no longer exposes argv (dropped dead custom-argv surface)",
);
assert(
	!delegateTool?.parameters?.properties?.argv,
	"herdr_delegate no longer exposes argv",
);
assert(
	startTool?.parameters?.properties?.agent?.type === "string",
	"herdr_start_agent `agent` is a free string (live-validated, not a stale enum)",
);
assert(
	delegateTool?.parameters?.properties?.agent?.type === "string",
	"herdr_delegate `agent` is a free string",
);
assert(
	!!startTool?.parameters?.properties?.agentArgs,
	"herdr_start_agent still exposes agentArgs (the supported local-ext loader)",
);

// ---------------------------------------------------------------------------
console.log(
	"\n[12] T4: Tier 3 pane-sync tools (split/run/read/wait_output/send_keys/close)",
);
const syncMod = await jiti.import(join(ROOT, "src/tools/sync.ts"), {
	parent: ROOT,
});
assert(
	typeof syncMod.waitOutputArgs === "function",
	"waitOutputArgs exported from sync (pure argv builder, offline-testable)",
);
const paneTools = [
	"herdr_split_pane",
	"herdr_run_command",
	"herdr_read_pane",
	"herdr_wait_output",
	"herdr_send_keys",
	"herdr_close_pane",
];
for (const n of paneTools) assert(names.includes(n), `registered ${n} (T4)`);
// Each T4 tool has the documented LLM hints (CONTRIBUTING: promptSnippet + guidelines).
for (const n of paneTools) {
	const t = tools.find((x) => x.name === n);
	assert(!!t?.promptSnippet, `${n} has promptSnippet`);
	assert(
		Array.isArray(t?.promptGuidelines) && t.promptGuidelines.length > 0,
		`${n} has promptGuidelines`,
	);
	assert(
		/split_pane|run_command|read_pane|wait_output|send_keys|close_pane/.test(
			t.promptGuidelines.join(" "),
		),
		`${n} promptGuidelines name the tool`,
	);
}
// waitOutputArgs: match path (default timeout always emitted — no indefinite hang).
assert(
	eq(
		syncMod.waitOutputArgs("w1:p3", { match: "ready" }),
		["pane", "wait-output", "w1:p3", "--match", "ready", "--timeout", "30000"],
	),
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
// AC7: destructive pane tools labeled ⚠️ (send_keys interrupts, close_pane kills).
const sendKeys = tools.find((t) => t.name === "herdr_send_keys");
const closePane = tools.find((t) => t.name === "herdr_close_pane");
assert(
	/⚠️/.test(sendKeys.description),
	"herdr_send_keys description carries ⚠️ (AC7: ctrl+c interrupts a process)",
);
assert(
	/⚠️/.test(closePane.description),
	"herdr_close_pane description carries ⚠️ (AC7: terminates the pane)",
);
// send_keys exposes agentScope (switches pane vs agent send-keys surface).
assert(
	!!sendKeys?.parameters?.properties?.agentScope,
	"herdr_send_keys exposes agentScope (pane send-keys vs agent send-keys)",
);

// ---------------------------------------------------------------------------
console.log(
	`\n${failed === 0 ? "✅ ALL PASS" : "❌ SOME FAILED"} (${passed} passed, ${failed} failed)`,
);
process.exit(failed === 0 ? 0 : 1);
