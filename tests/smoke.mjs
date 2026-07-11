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
const mockPi = {
  registerTool: (def) => tools.push(def),
  on: (ev, handler) => {
    (events[ev] ??= []).push(handler);
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
assert(names.length === expected.length, `exactly ${expected.length} tools (got ${names.length})`);
assert(events.agent_start?.length === 1, "wired agent_start footer hook");
assert(events.turn_end?.length === 1, "wired turn_end footer hook");

// AC7: destructive tools labeled
const stop = tools.find((t) => t.name === "herdr_stop_agent");
assert(/⚠️/.test(stop.description), "herdr_stop_agent description carries ⚠️ (AC7)");
for (const t of tools) {
  assert(typeof t.parameters === "object", `${t.name} has parameters schema`);
  assert(typeof t.execute === "function", `${t.name} has execute()`);
}

// ---------------------------------------------------------------------------
console.log("\n[2] Launcher preset -> argv (AC4)");
const launcher = await jiti.import(join(ROOT, "src/launcher.ts"), { parent: ROOT });
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
assert(!bad.ok && bad.error.code === "VALIDATION_ERROR", "unknown preset -> VALIDATION_ERROR");

// ---------------------------------------------------------------------------
console.log("\n[3] herdr() unavailable path (AC5)");
const herdrMod = await jiti.import(join(ROOT, "src/herdr.ts"), { parent: ROOT });
process.env.HERDR_BIN = "Z:\\nonexistent\\herdr-binary.exe";
const unavailable = await herdrMod.herdr(["agent", "list"], { timeoutMs: 3_000 });
assert(
  !unavailable.ok && unavailable.error.code === "HERDR_UNAVAILABLE",
  "missing binary -> HERDR_UNAVAILABLE, no throw/hang (AC5)",
);

// ---------------------------------------------------------------------------
console.log("\n[4] herdr() envelope parse + error mapping + raw text");
// Use node.exe (native, shell:false-safe) as a fake herdr via -e scripts.
process.env.HERDR_BIN = NODE;

const okOut = await herdrMod.herdr(
  ["-e", 'console.log(JSON.stringify({id:"x",result:{agents:[],type:"agent_list"}}))'],
  { timeoutMs: 5_000 },
);
assert(okOut.ok && eq(okOut.data, { agents: [], type: "agent_list" }), "parses success envelope -> result");

const errOut = await herdrMod.herdr(
  ["-e", 'console.log(JSON.stringify({error:{code:"agent_start_failed",message:"boom"},id:"x"}))'],
  { timeoutMs: 5_000 },
);
assert(
  !errOut.ok && errOut.error.code === "AGENT_START_FAILED" && errOut.error.message === "boom",
  `maps agent_start_failed -> AGENT_START_FAILED (got ${errOut.error?.code})`,
);

const rawOut = await herdrMod.herdr(["-e", 'process.stdout.write("pong\\n")'], {
  timeoutMs: 5_000,
  textOk: true,
});
assert(rawOut.ok && rawOut.data === "pong\n", "textOk returns raw stdout as data");

// ---------------------------------------------------------------------------
console.log("\n[5] herdr() timeout (AC6)");
const t0 = Date.now();
const timeoutOut = await herdrMod.herdr(["-e", "setInterval(()=>{},60000)"], { timeoutMs: 1_200 });
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
const schemaOut = await herdrMod.herdr(["api", "schema", "--json"], { timeoutMs: 10_000 });
assert(
  schemaOut.ok && typeof schemaOut.data === "object" && schemaOut.data?.schemas,
  "real herdr.exe 'api schema --json' parsed as JSON (validates native spawn + parse)",
);

// ---------------------------------------------------------------------------
console.log(`\n${failed === 0 ? "✅ ALL PASS" : "❌ SOME FAILED"} (${passed} passed, ${failed} failed)`);
process.exit(failed === 0 ? 0 : 1);
