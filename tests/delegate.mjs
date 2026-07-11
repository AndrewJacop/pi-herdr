// AC3: exercise the real `herdr_delegate` composite tool end-to-end against a
// live herdr server + spawned `pi` agent. Loads orchestration via a mock pi,
// finds the delegate tool, and invokes execute() with a real prompt.
//
// Run: node tests/delegate.mjs   (requires a running herdr session)

import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url);
const orch = await jiti.import(join(ROOT, "src/tools/orchestration.ts"), { parent: ROOT });

const tools = [];
const mockPi = { registerTool: (d) => tools.push(d), on: () => {} };
orch.registerOrchestration(mockPi);

const delegate = tools.find((t) => t.name === "herdr_delegate");
if (!delegate) {
  console.error("✗ herdr_delegate tool not registered");
  process.exit(1);
}

console.log("[delegate] invoking herdr_delegate with a real prompt...");
const res = await delegate.execute(
  "smoke-call",
  { prompt: "Reply with exactly one word: pong", timeoutMs: 240_000 },
  undefined,
);

const text = res.content?.[0]?.text ?? "";
console.log("    isError:", res.isError ?? false);
console.log("    paneId:", res.details?.paneId);
console.log("    --- response ---");
console.log(text.split("\n").map((l) => "    " + l).join("\n").slice(0, 600));

let pass = 0,
  fail = 0;
const check = (c, m) => {
  pass += c ? 1 : 0;
  fail += c ? 0 : 1;
  console.log((c ? "  ✓ " : "  ✗ ") + m);
};
check(!res.isError, "delegate returned success (not error)");
check(/pong/i.test(text), "delegate response contains 'pong' (AC3)");
check(!!res.details?.paneId, `delegate returned paneId (${res.details?.paneId})`);

// cleanup the spawned pane (delegate keeps it alive by default)
if (res.details?.paneId) {
  const herdr = (await jiti.import(join(ROOT, "src/herdr.ts"), { parent: ROOT })).herdr;
  const c = await herdr(["pane", "close", res.details.paneId], { timeoutMs: 10_000 });
  check(c.ok, `cleanup: closed ${res.details.paneId}`);
}

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ SOME FAILED"} (${pass}/${pass + fail})`);
process.exit(fail === 0 ? 0 : 1);
