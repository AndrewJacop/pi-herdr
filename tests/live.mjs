// Live integration test — requires a running herdr server.
// Exercises the REAL extension spawn path (herdr_spawn_agent via the
// registered tool, loaded through jiti) plus the agent list envelope parse:
// the single `agent start --kind` launch path, same on every platform.
//
// Run: node tests/live.mjs   (after starting a `herdr` session)

import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url);
const agentsTool = await jiti.import(join(ROOT, "src/tools/agents.ts"), {
	parent: ROOT,
});
const { herdr } = await jiti.import(join(ROOT, "src/herdr.ts"), {
	parent: ROOT,
});

const tools = [];
const mockPi = { registerTool: (d) => tools.push(d), on: () => {} };
agentsTool.registerAgents(mockPi);
const spawnTool = tools.find((t) => t.name === "herdr_spawn_agent");
if (!spawnTool) {
	console.error("✗ herdr_spawn_agent tool not registered");
	process.exit(1);
}

let pass = 0,
	fail = 0;
const check = (c, m) => {
	pass += c ? 1 : 0;
	fail += c ? 0 : 1;
	console.log((c ? "  ✓ " : "  ✗ ") + m);
};

console.log("[live] herdr_spawn_agent tool (real extension path)");
const name = `live-ac-${Date.now()}`;
const res = await spawnTool.execute(
	"live-ac",
	{
		name,
		prompt: "Reply with exactly one word: pong",
		cwd: ROOT,
		wait: 240_000,
	},
	undefined,
);
const d = res.details ?? {};
const paneId = d.paneId ?? null;
check(res.isError !== true, `spawn ok (isError=${res.isError})`);
check(!!paneId, `paneId present: ${paneId}`);
check(d.name === name, `handle returned: ${d.name}`);
check(
	d.status === "done" || d.status === "blocked",
	`wait settled terminal, status: ${d.status}`,
);

if (paneId) {
	// the pane is tracked as an agent (agent get — machinery, post-surface-cut)
	const g = await herdr(["agent", "get", paneId], { timeoutMs: 10_000 });
	const a = g.ok ? (g.data?.agent ?? g.data) : null;
	check(g.ok && !!a?.pane_id, `agent get tracks the pane (${a?.agent_status})`);
	// the reply came back (pane-tail read — the fallback reader)
	const read = await herdr(
		[
			"agent",
			"read",
			paneId,
			"--source",
			"recent",
			"--lines",
			"30",
			"--format",
			"text",
		],
		{ timeoutMs: 15_000, textOk: true },
	);
	const text = read.ok ? String(read.data ?? "") : "";
	check(/pong/i.test(text), "response contains 'pong'");
}

console.log("\n[live] agent list real envelope parse");
const list = await herdr(["agent", "list"], { timeoutMs: 10_000 });
check(
	list.ok && Array.isArray(list.data?.agents),
	`list ok, ${list.data?.agents?.length} agent(s)`,
);

console.log("\n[live] cleanup — close all live-ac* panes");
const agents = list.ok ? (list.data?.agents ?? []) : [];
for (const ag of agents) {
	if (String(ag.name ?? "").startsWith("live-ac")) {
		const c = await herdr(["pane", "close", ag.pane_id], { timeoutMs: 10_000 });
		check(c.ok, `closed ${ag.name} (${ag.pane_id})`);
	}
}

console.log(
	`\n${fail === 0 ? "✅ ALL PASS" : "❌ SOME FAILED"} (${pass}/${pass + fail})`,
);
process.exit(fail === 0 ? 0 : 1);
