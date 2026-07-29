// Live Windows test: exercise the fixed `herdr_start_agent` launch path
// (startAgentNew → startAgentWindowsPaneRun: pane split + pane run + auto-detect)
// and every other orchestration tool against the pane it creates.
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
const orch = await jiti.import(join(ROOT, "src/tools/orchestration.ts"), {
	parent: ROOT,
});
const { herdr } = await jiti.import(join(ROOT, "src/herdr.ts"), {
	parent: ROOT,
});

const tools = [];
const mockPi = { registerTool: (d) => tools.push(d), on: () => {} };
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
	console.log(
		"[win-start] 1. herdr_start_agent (the fixed Windows launch path)",
	);
	const start = await tool("herdr_start_agent").execute(
		"t",
		{ name: NAME, agent: "pi", cwd: ROOT, split: "right" },
		NO_SIGNAL,
	);
	console.log(
		"    isError:",
		start.isError ?? false,
		"text:",
		start.content?.[0]?.text ?? "",
	);
	paneId = start.details?.paneId;
	check(!start.isError, `start_agent succeeded (the pane-run fix works)`);
	check(!!paneId, `returned paneId (${paneId})`);
	if (!paneId) throw new Error("no pane id");

	console.log("\n[win-start] 2. herdr_get_agent");
	const get = await tool("herdr_get_agent").execute(
		"t",
		{ target: paneId },
		NO_SIGNAL,
	);
	check(!get.isError, `get_agent ok: ${get.content?.[0]?.text ?? ""}`);

	console.log("\n[win-start] 3. herdr_list_agents (pane should appear)");
	const list = await tool("herdr_list_agents").execute("t", {}, NO_SIGNAL);
	check(!list.isError, "list_agents ok");
	check(
		(list.details?.agents ?? []).some((a) => a.paneId === paneId),
		`list includes our pane (${paneId})`,
	);

	console.log("\n[win-start] 4. herdr_rename_agent");
	const ren = await tool("herdr_rename_agent").execute(
		"t",
		{ target: paneId, name: NAME + "-renamed" },
		NO_SIGNAL,
	);
	check(!ren.isError, `rename_agent ok`);

	console.log("\n[win-start] 5. herdr_focus_agent");
	const focus = await tool("herdr_focus_agent").execute(
		"t",
		{ target: paneId },
		NO_SIGNAL,
	);
	check(!focus.isError, `focus_agent ok`);

	console.log("\n[win-start] 6. herdr_wait_agent (boot -> idle)");
	const boot = await tool("herdr_wait_agent").execute(
		"t",
		{ target: paneId, status: "idle", timeoutMs: 90_000 },
		NO_SIGNAL,
	);
	check(!boot.isError, `boot -> idle`);

	console.log("\n[win-start] 7. herdr_send_prompt");
	const send = await tool("herdr_send_prompt").execute(
		"t",
		{ target: paneId, text: "Reply with exactly one word: pong" },
		NO_SIGNAL,
	);
	check(!send.isError, `send_prompt ok`);

	console.log("\n[win-start] 8. herdr_wait_agent (turn -> idle)");
	const turn = await tool("herdr_wait_agent").execute(
		"t",
		{ target: paneId, status: "idle", timeoutMs: 120_000 },
		NO_SIGNAL,
	);
	check(!turn.isError, `turn -> idle`);

	console.log("\n[win-start] 9. herdr_read_agent (expect 'pong')");
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
	check(/pong/i.test(text), `response contains 'pong'`);
} finally {
	if (paneId) {
		console.log("\n[win-start] 10. herdr_stop_agent (cleanup)");
		const stop = await tool("herdr_stop_agent").execute(
			"t",
			{ target: paneId },
			NO_SIGNAL,
		);
		check(!stop.isError, `stop_agent ok (closed ${paneId})`);
		// belt-and-suspenders: ensure the pane is really gone
		await herdr(["pane", "close", paneId], { timeoutMs: 10_000 }).catch(
			() => {},
		);
	}
}

console.log(
	`\n${fail === 0 ? "✅ ALL PASS" : "❌ SOME FAILED"} (${pass}/${pass + fail})`,
);
process.exit(fail === 0 ? 0 : 1);
