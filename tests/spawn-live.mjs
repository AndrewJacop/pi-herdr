// Live integration test for the spawn_agent tracer bullet (issue 02), now
// carrying the v0.6 substrate (issue 04): the spawn runs on a parent-owned
// session file, the autonomous child auto-exits on settle, and the result is
// pulled with herdr_get_agent_result — the EXACT final assistant message from
// the session JSONL (no screen scraping). Proves the child env carries the
// incremented PI_HERDR_SPAWN_DEPTH: the child echoes it, and the parent reads
// the echo from the session file, byte-identical.
//
// Hermetic-ish: runs in a temp project dir with its own .pi/herdr.json so the
// dev machine's project settings can't flip a gate (global settings still
// merge — a kill-switch there fails this test honestly).
//
// Run: node tests/spawn-live.mjs   (after starting a `herdr` session)

import { createJiti } from "jiti";
import {
	existsSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
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
const resultTool = await jiti.import(join(ROOT, "src/tools/result.ts"), {
	parent: ROOT,
});
const { herdr } = await jiti.import(join(ROOT, "src/herdr.ts"), {
	parent: ROOT,
});
const { sessionsDirFor } = await jiti.import(join(ROOT, "src/sessionfile.ts"), {
	parent: ROOT,
});
const { readActivityFile } = await jiti.import(join(ROOT, "src/status.ts"), {
	parent: ROOT,
});

const tools = [];
const mockPi = { registerTool: (d) => tools.push(d), on: () => {} };
agentsTool.registerAgents(mockPi);
resultTool.registerResultTool(mockPi);
const spawnTool = tools.find((t) => t.name === "herdr_spawn_agent");
const getResult = tools.find((t) => t.name === "herdr_get_agent_result");
if (!spawnTool || !getResult) {
	console.error("✗ tools not registered");
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
			// general-purpose: the task is 'run a command and echo it', and the
			// depth echo proves the child env contract end to end. Explore's
			// read-only system prompt makes small models refuse to run anything.
			type: "general-purpose",
			name,
			prompt:
				"Use the bash tool to run exactly: echo $PI_HERDR_SPAWN_DEPTH — then reply with only its output (a single number). Do not guess; run the command.",
			wait: 180_000,
		},
		undefined,
	);
	const d = res.details ?? {};
	check(res.isError !== true, `spawn ok (isError=${res.isError})`);
	check(!!d.paneId, `paneId present: ${d.paneId}`);
	check(d.name === name, `handle returned: ${d.name}`);
	check(d.type === "general-purpose", `type reported: ${d.type}`);
	check(d.depth === 2, `child depth = 2 (root 1 + 1), got ${d.depth}`);
	check(
		d.status === "done" || d.status === "blocked",
		`wait:180s settled terminal, status: ${d.status}`,
	);

	if (d.paneId) {
		// The substrate round-trip: pull the result with herdr_get_agent_result —
		// the EXACT final assistant message from the parent-owned session file,
		// not a screen scrape. wait:150s rides past transient provider retries:
		// a flaky connection settles as an error first, and the child extension's
		// grace window lets pi's retry machine run before declaring exhaustion.
		const res = await getResult.execute(
			"live-result",
			{ target: d.name, wait: 150_000 },
			undefined,
		);
		const v = res.details ?? {};
		check(res.isError !== true || v.status === "error", `get_agent_result returned (status: ${v.status})`);
		check(
			v.source === "session-jsonl",
			`result sourced from the session JSONL (got ${v.source})`,
		);
		check(
			v.message?.role === "assistant",
			"the full last assistant message object rides in details",
		);
		check(
			typeof v.sessionPath === "string" &&
				existsSync(v.sessionPath),
			`parent-owned session file exists on disk (${v.sessionPath})`,
		);
		check(
			typeof v.sessionPath === "string" &&
				v.sessionPath.startsWith(sessionsDirFor(tmp)) &&
				v.sessionPath.endsWith(".jsonl"),
			`session file lives in pi's default sessions dir for the child cwd (${v.sessionPath})`,
		);

		if (v.status === "done") {
			check(
				/(^|\D)2(\D|$)/.test(String(v.result ?? "")),
				`child echoed PI_HERDR_SPAWN_DEPTH=2 in its EXACT final message (${JSON.stringify(String(v.result ?? "").slice(0, 80))})`,
			);
			check(
				typeof v.exitPath === "string" && existsSync(v.exitPath),
				"autonomous child wrote its typed completion sidecar (<session>.exit)",
			);
			const sidecar = JSON.parse(readFileSync(v.exitPath, "utf8"));
			check(sidecar.type === "done", "sidecar is typed done");

			// The activity recorder (issue 07): the child mirrored its lifecycle
			// into the activity sidecar — valid snapshot, settled at the end.
			// (d.activityPath comes from the spawn result — the jiti-direct
			// spawn.ts import here holds a DIFFERENT registry instance than the
			// one tools/agents.ts populated.)
			const act = readActivityFile(d.activityPath);
			check(
				act.state === "ok" && act.activity.phase === "waiting",
				`activity sidecar written by the child and settled (got ${act.state}/${act.activity?.phase})`,
			);
		} else if (v.status === "error") {
			// typed failure — the substrate did its job; the provider connection
			// did not. Surface the mined message so the flake is diagnosable.
			check(
				false,
				`child finished with a TYPED error (sidecar mining works; provider flaked): ${v.error?.errorMessage} — rerun`,
			);
		} else {
			check(false, `unexpected result status: ${v.status}`);
		}

		// An autonomous child auto-exits on settle: the pane (and its agent
		// entry) is typically GONE by now, and that is correct — the session
		// file above is the retained truth. Accept either live or gone.
		const g = await herdr(["agent", "get", d.paneId], { timeoutMs: 10_000 });
		const status = g.ok
			? ((g.data?.agent ?? g.data)?.agent_status ?? "live")
			: "gone (auto-exited — session retained)";
		check(
			g.ok || v.status === "gone" || v.status === "done",
			`pane state after settle: ${status}`,
		);
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
