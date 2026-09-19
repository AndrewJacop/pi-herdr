// Live Windows test: exercise the single launch path (pane split + `agent
// start --kind` — the only path since the v0.6 version floor) through the
// KEPT surface (herdr_spawn_agent; herdr_start_agent died with the v0.6
// surface cut — the spawn engine calls the same startHerdrAgent machinery), and
// every kept agent tool against the pane it creates.
//
// Loads the REAL src via jiti (so it runs the edited code, no publish needed),
// registers tools through a mock pi, and invokes each tool's execute().
// Self-skips on non-Windows so it is safe inside `npm run test:live` on macOS.
//
// Run: node tests/win-start.mjs   (requires a running herdr session + model key)

import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

if (process.platform !== "win32") {
	console.log("[win-start] skipped (Windows-only)");
	process.exit(0);
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url);
const agentsTool = await jiti.import(join(ROOT, "src/tools/agents.ts"), {
	parent: ROOT,
});
const orch = await jiti.import(join(ROOT, "src/tools/orchestration.ts"), {
	parent: ROOT,
});
const { herdr } = await jiti.import(join(ROOT, "src/herdr.ts"), {
	parent: ROOT,
});

const tools = [];
const mockPi = { registerTool: (d) => tools.push(d), on: () => {} };
agentsTool.registerAgents(mockPi);
orch.registerOrchestration(mockPi);
const tool = (name) => {
	const t = tools.find((t) => t.name === name);
	if (!t) throw new Error(`tool not registered: ${name}`);
	return t;
};
const NO_SIGNAL = undefined;

let pass = 0,
	fail = 0;
const check = (c, m) => {
	pass += c ? 1 : 0;
	fail += c ? 0 : 1;
	console.log((c ? "  ✓ " : "  ✗ ") + m);
};

const NAME = `win-start-${Date.now()}`;
let paneId = null;

try {
	console.log("[win-start] 1. herdr_spawn_agent (the single launch path)");
	const spawn = await tool("herdr_spawn_agent").execute(
		"t",
		{
			name: NAME,
			prompt: "Reply with exactly one word: pong",
			cwd: ROOT,
			wait: 300_000,
		},
		NO_SIGNAL,
	);
	console.log(
		"    isError:",
		spawn.isError ?? false,
		"text:",
		spawn.content?.[0]?.text ?? "",
	);
	paneId = spawn.details?.paneId;
	check(
		!spawn.isError,
		`spawn_agent succeeded (the single --kind path works on Windows)`,
	);
	check(!!paneId, `returned paneId (${paneId})`);
	check(
		spawn.details?.status === "done" || spawn.details?.status === "blocked",
		`wait settled terminal (status: ${spawn.details?.status})`,
	);
	if (!paneId) throw new Error("no pane id");

	console.log("\n[win-start] 2. agent get (machinery — the poll path)");
	const g = await herdr(["agent", "get", paneId], { timeoutMs: 10_000 });
	const a = g.ok ? (g.data?.agent ?? g.data) : null;
	check(g.ok && !!a?.pane_id, `agent get tracks the pane (${a?.agent_status})`);

	console.log("\n[win-start] 3. herdr_list_agents (pane should appear)");
	const list = await tool("herdr_list_agents").execute("t", {}, NO_SIGNAL);
	check(!list.isError, "list_agents ok");
	check(
		(list.details?.agents ?? []).some((x) => x.paneId === paneId),
		`list includes our pane (${paneId})`,
	);

	console.log("\n[win-start] 4. herdr_send_prompt");
	const send = await tool("herdr_send_prompt").execute(
		"t",
		{ target: paneId, text: "Reply with exactly one word: ping" },
		NO_SIGNAL,
	);
	check(!send.isError, `send_prompt ok`);

	console.log("\n[win-start] 5. herdr_wait_agent (turn -> idle)");
	const turn = await tool("herdr_wait_agent").execute(
		"t",
		{ target: paneId, status: "idle", timeoutMs: 120_000 },
		NO_SIGNAL,
	);
	check(!turn.isError, `turn -> idle`);

	console.log("\n[win-start] 6. herdr_read_agent (expect 'ping')");
	await new Promise((r) => setTimeout(r, 1500)); // let the response render before reading
	const read = await tool("herdr_read_agent").execute(
		"t",
		{ target: paneId, source: "recent", lines: 60 },
		NO_SIGNAL,
	);
	const text = read.content?.[0]?.text ?? "";
	console.log(
		"    --- tail of response ---\n" +
			text
				.split("\n")
				.filter(Boolean)
				.slice(-6)
				.map((l) => "    " + l)
				.join("\n"),
	);
	check(!read.isError, `read_agent ok`);
	check(/ping/i.test(text), `response contains 'ping'`);
} finally {
	if (paneId) {
		console.log("\n[win-start] 7. cleanup (pane close — the kill-all primitive)");
		const c = await herdr(["pane", "close", paneId], { timeoutMs: 10_000 });
		check(c.ok, `pane closed (${paneId})`);
	}
}

console.log(
	`\n${fail === 0 ? "✅ ALL PASS" : "❌ SOME FAILED"} (${pass}/${pass + fail})`,
);
process.exit(fail === 0 ? 0 : 1);
