// Live integration test — requires a running herdr server.
// Proves the real extension spawn path (Node child_process, shell:false) passes
// the Windows `cmd /c pi` argv LITERALLY (no Git Bash /c -> C:/ mangling),
// i.e. AC4 through the actual herdr.ts code.
//
// Run: node tests/live.mjs   (after starting a `herdr` session)

import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url);
const herdr = (await jiti.import(join(ROOT, "src/herdr.ts"), { parent: ROOT })).herdr;

let pass = 0,
  fail = 0;
const check = (c, m) => {
  pass += c ? 1 : 0;
  fail += c ? 0 : 1;
  console.log((c ? "  ✓ " : "  ✗ ") + m);
};

console.log("[live] agent start via Node spawn (shell:false) — AC4");
const start = await herdr(["agent", "start", "ac4node", "--no-focus", "--", "cmd", "/c", "pi"], {
  timeoutMs: 20_000,
});
check(start.ok, `start succeeded (error code=${start.error?.code})`);
const a = start.ok ? start.data?.agent : null;
check(!!a?.pane_id, `pane_id present: ${a?.pane_id}`);
check(
  JSON.stringify(start.data?.argv) === JSON.stringify(["cmd", "/c", "pi"]),
  `argv passed LITERALLY as ["cmd","/c","pi"] (got ${JSON.stringify(start.data?.argv)}) — AC4, no mangling`,
);
check(!JSON.stringify(start).includes("os error 193"), "no 'Win32 application' os error 193 (AC4)");

console.log("\n[live] agent list real envelope parse");
const list = await herdr(["agent", "list"], { timeoutMs: 10_000 });
check(list.ok && Array.isArray(list.data?.agents), `list ok, ${list.data?.agents?.length} agent(s)`);

console.log("\n[live] cleanup — close all ac4* panes");
const agents = list.ok ? list.data?.agents ?? [] : [];
for (const ag of agents) {
  if (String(ag.name ?? "").startsWith("ac4")) {
    const c = await herdr(["pane", "close", ag.pane_id], { timeoutMs: 10_000 });
    check(c.ok, `closed ${ag.name} (${ag.pane_id})`);
  }
}

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ SOME FAILED"} (${pass}/${pass + fail})`);
process.exit(fail === 0 ? 0 : 1);
