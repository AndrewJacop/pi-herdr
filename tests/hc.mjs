// Offline tests for the herdr-core (`hc`) backend (src/hc.ts): backend
// detection and the herdr → hc translation against a fake program runner.
// No hc or Herdr app needed.
//
// Run: node tests/hc.mjs

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
function eq(a, b) {
	return JSON.stringify(a) === JSON.stringify(b);
}

const hc = await jiti.import(join(ROOT, "src/hc.ts"));

console.log("\n[1] Backend detection");
assert(hc.useHc({ HC_TERMINAL_ID: "t1" }), "HC_TERMINAL_ID → hc");
assert(!hc.useHc({ HC_TERMINAL_ID: "t1", HERDR_PANE_ID: "p1" }), "a herdr pane → herdr");
assert(!hc.useHc({ PI_HERDR_BACKEND: "herdr", HC_TERMINAL_ID: "t1" }), "PI_HERDR_BACKEND overrides");
assert(hc.selfPaneId({ HC_TERMINAL_ID: "t7" }) === "t7", "selfPaneId: the hc terminal");

console.log("\n[2] Translation against a fake runner");
const calls = [];
let answer;
hc.setRunnerForTests(async (bin, args) => {
	calls.push([bin.split("/").pop(), ...args]);
	return answer(args);
});
const json = (o) => ({ code: 0, stdout: JSON.stringify(o), stderr: "" });

answer = () =>
	json({ address: "t9", labels: { "pi-herdr.name": "w1" }, status: { state: "done", app: "claude-code" } });
let r = await hc.hcHerdr(["agent", "get", "t9"]);
assert(
	r.ok && r.data.agent.pane_id === "t9" && r.data.agent.name === "w1" &&
		r.data.agent.agent === "claude" && r.data.agent.agent_status === "done",
	"agent get → herdr's agent shape",
);

// hc writes errors as JSON on stderr; a name is then looked up by label.
answer = (args) =>
	args[0] === "get"
		? { code: 3, stdout: "", stderr: JSON.stringify({ error: { kind: "not_found", message: "no" } }) }
		: json({ terminals: [] });
r = await hc.hcHerdr(["agent", "get", "ghost"]);
assert(!r.ok && r.error.details.code === "agent_not_found", "unknown target → agent_not_found");

answer = (args) =>
	args[0] === "get"
		? json({ address: "t3", labels: {} })
		: json({ turn: 1, wait: { ended: false, reason: "not_started" } });
r = await hc.hcHerdr(["agent", "prompt", "t3", "hi", "--wait", "--timeout", "5000"]);
assert(!r.ok && r.error.details.code === "agent_prompt_stalled", "unstarted prompt → agent_prompt_stalled");
assert(eq(calls.at(-1), ["hc", "send", "t3", "hi", "--wait", "--timeout", "5", "--json"]), "prompt → hc send --wait");

calls.length = 0;
answer = () => json({});
r = await hc.hcHerdr(["agent", "start", "w2", "--kind", "cursor", "--pane", "t6", "--", "-p", "a b"]);
assert(r.ok && eq(calls[1], ["hc", "send", "t6", "cursor-agent -p 'a b'", "--json"]), "agent start types the quoted command");

calls.length = 0;
answer = (args) => (args[0] === "run" ? json({ address: "t5" }) : { code: 1, stdout: "", stderr: "" });
r = await hc.hcHerdr(["pane", "split", "--current", "--direction", "down", "--cwd", "/w"]);
const run = calls.find((c) => c[1] === "run");
assert(r.ok && r.data.pane.pane_id === "t5", "pane split without the app → hc run");
assert(run && run.indexOf("--json") < run.indexOf("--"), "hc run: --json before --");
hc.setRunnerForTests(null);

console.log(
	`\n${failed === 0 ? "✅ ALL PASS" : "❌ SOME FAILED"} (${passed} passed, ${failed} failed)`,
);
process.exit(failed === 0 ? 0 : 1);
