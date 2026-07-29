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
console.log(
	`\n${failed === 0 ? "✅ ALL PASS" : "❌ SOME FAILED"} (${passed} passed, ${failed} failed)`,
);
process.exit(failed === 0 ? 0 : 1);
