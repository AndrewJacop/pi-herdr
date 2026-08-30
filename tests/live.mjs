// Live integration test — requires a running herdr server.
// Exercises the REAL extension start path (herdr_start_agent via the
// registered tool, loaded through jiti) plus the agent list envelope parse.
// The original AC4 (literal `cmd /c pi` argv through legacy `agent start`)
// died with that surface in herdr 0.7.5+; on Windows the extension now types
// the bare command via `pane run` (no argv array to mangle), and on POSIX it
// uses `agent start --kind` whose argv echo is covered by `agent get`.
//
// Run: node tests/live.mjs   (after starting a `herdr` session)

import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url);
const orch = await jiti.import(join(ROOT, "src/tools/orchestration.ts"), {
	parent: ROOT,
});
const { herdr } = await jiti.import(join(ROOT, "src/herdr.ts"), {
	parent: ROOT,
});

const tools = [];
const mockPi = { registerTool: (d) => tools.push(d), on: () => {} };
orch.registerOrchestration(mockPi);
const startTool = tools.find((t) => t.name === "herdr_start_agent");
if (!startTool) {
	console.error("✗ herdr_start_agent tool not registered");
	process.exit(1);
}

let pass = 0,
	fail = 0;
const check = (c, m) => {
	pass += c ? 1 : 0;
	fail += c ? 0 : 1;
	console.log((c ? "  ✓ " : "  ✗ ") + m);
};

console.log("[live] herdr_start_agent tool (real extension path)");
const res = await startTool.execute(
	"live-ac",
	{ name: "ac4node", agent: "pi", cwd: ROOT },
	undefined,
);
const paneId = res.details?.paneId ?? null;
check(res.isError !== true, `start succeeded (isError=${res.isError})`);
check(!!paneId, `paneId present: ${paneId}`);

if (paneId) {
	const g = await herdr(["agent", "get", paneId], { timeoutMs: 10_000 });
	const a = g.ok ? (g.data?.agent ?? g.data) : null;
	check(g.ok && !!a?.pane_id, `agent get tracks the pane (${a?.agent_status})`);
}

console.log("\n[live] agent list real envelope parse");
const list = await herdr(["agent", "list"], { timeoutMs: 10_000 });
check(
	list.ok && Array.isArray(list.data?.agents),
	`list ok, ${list.data?.agents?.length} agent(s)`,
);

console.log("\n[live] cleanup — close all ac4* panes");
const agents = list.ok ? (list.data?.agents ?? []) : [];
for (const ag of agents) {
	if (String(ag.name ?? "").startsWith("ac4")) {
		const c = await herdr(["pane", "close", ag.pane_id], { timeoutMs: 10_000 });
		check(c.ok, `closed ${ag.name} (${ag.pane_id})`);
	}
}

console.log(
	`\n${fail === 0 ? "✅ ALL PASS" : "❌ SOME FAILED"} (${pass}/${pass + fail})`,
);
process.exit(fail === 0 ? 0 : 1);
