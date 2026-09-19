// Live integration test for the spawn_agent tracer bullet (issue 02).
// Requires a running herdr server. Exercises the REAL spawn path end to end:
// the registered herdr_spawn_agent tool (default deps — real settings read,
// real startHerdrAgent, real boot gate + prompt submit) with the built-in
// Explore type, and proves the child env carries the incremented
// PI_HERDR_SPAWN_DEPTH (the child echoes it back via its read-only bash tool).
//
// Hermetic-ish: runs in a temp project dir with its own .pi/herdr.json so the
// dev machine's project settings can't flip a gate (global settings still
// merge — a kill-switch there fails this test honestly).
//
// Run: node tests/spawn-live.mjs   (after starting a `herdr` session)

import { createJiti } from "jiti";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// temp project with pinned settings; chdir so defaultLoad + child cwd land here
const tmp = mkdtempSync(join(tmpdir(), "pi-herdr-spawn-live-"));
mkdirSync(join(tmp, ".pi"), { recursive: true });
writeFileSync(
	join(tmp, ".pi", "herdr.json"),
	JSON.stringify({
		agents_kill_switch: false,
		max_parallel_agents: 3,
		max_spawn_depth: 2,
		default_kind: "pi",
	}),
);
process.chdir(tmp);

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
	console.log("[live] herdr_spawn_agent — built-in Explore, real path");
	const name = `spawnlive-${Date.now()}`;
	const res = await spawnTool.execute(
		"live-spawn",
		{
			type: "Explore",
			name,
			prompt:
				"Use the bash tool to run exactly: echo $PI_HERDR_SPAWN_DEPTH — then reply with only its output (a single number).",
			wait: 180_000,
		},
		undefined,
	);
	const d = res.details ?? {};
	check(res.isError !== true, `spawn ok (isError=${res.isError})`);
	check(!!d.paneId, `paneId present: ${d.paneId}`);
	check(d.name === name, `handle returned: ${d.name}`);
	check(d.type === "Explore", `type reported: ${d.type}`);
	check(d.depth === 2, `child depth = 2 (root 1 + 1), got ${d.depth}`);
	check(
		d.status === "done" || d.status === "blocked",
		`wait:180s settled terminal, status: ${d.status}`,
	);

	if (d.paneId) {
		// read the result text — the child should have echoed the env value
		const readR = await herdr(
			[
				"agent",
				"read",
				d.paneId,
				"--source",
				"recent",
				"--lines",
				"30",
				"--format",
				"text",
			],
			{ timeoutMs: 15_000, textOk: true },
		);
		const text = readR.ok ? String(readR.data ?? "") : "";
		check(
			/(^|\D)2(\D|$)/.test(text),
			"child echoed PI_HERDR_SPAWN_DEPTH=2 (env stamp reached the pane)",
		);
		// the read-only allowlist reached the child: agent get echoes the argv
		const g = await herdr(["agent", "get", d.paneId], { timeoutMs: 10_000 });
		const a = g.ok ? (g.data?.agent ?? g.data) : null;
		check(g.ok && !!a?.pane_id, `agent get tracks the pane (${a?.agent_status})`);
	}

	console.log("\n[live] cleanup");
	if (d.paneId) {
		const c = await herdr(["pane", "close", d.paneId], { timeoutMs: 10_000 });
		check(c.ok, `closed pane ${d.paneId}`);
	}
	await sleep(500);
} finally {
	try {
		rmSync(tmp, { recursive: true, force: true });
	} catch {
		/* best-effort */
	}
}

console.log(
	`\n${fail === 0 ? "✅ ALL PASS" : "❌ SOME FAILED"} (${pass}/${pass + fail})`,
);
process.exit(fail === 0 ? 0 : 1);
