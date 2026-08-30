// Live end-to-end: ping -> pong through the extension's real send path
// (herdr_send_prompt tool, which carries the AGENT_NOT_READY pane-level
// fallback) against a live herdr server + a spawned `pi` agent (AC2).
// Requires a running herdr session and a working model/API key.
//
// Run: node tests/pong.mjs

import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { spawnPiAgent, waitStatus } from "./_spawn.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url);
const { herdr } = await jiti.import(join(ROOT, "src/herdr.ts"), {
	parent: ROOT,
});
const { extractText } = await jiti.import(join(ROOT, "src/env.ts"), {
	parent: ROOT,
});
const orch = await jiti.import(join(ROOT, "src/tools/orchestration.ts"), {
	parent: ROOT,
});
const tools = [];
orch.registerOrchestration({
	registerTool: (d) => tools.push(d),
	on: () => {},
});
const sendTool = tools.find((t) => t.name === "herdr_send_prompt");

let pass = 0,
	fail = 0;
const check = (c, m) => {
	pass += c ? 1 : 0;
	fail += c ? 0 : 1;
	console.log((c ? "  ✓ " : "  ✗ ") + m);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Neutral cwd so the project's package.json does not auto-load extensions.
const CWD = mkdtempSync(join(tmpdir(), "pi-herdr-pong-"));
const spawned = await spawnPiAgent("pi-pong", { cwd: CWD });
const paneId = spawned.paneId ?? null;

try {
	check(!!paneId, `1. spawned pi agent (pane: ${paneId})`);
	if (!paneId) throw new Error(spawned.error?.message ?? "spawn failed");

	// Wait for the pane to reach an interactive state. herdr 0.8.2 Windows
	// panes settle at `idle` via screen detection; `done` is equally fine.
	const boot = await waitStatus(paneId, ["idle", "done"], 60_000);
	check(!!boot, `2. booted to idle/done (got ${boot})`);
	await sleep(1_500); // brief settle so the TUI input is ready

	console.log("\n[pong] 3. send via herdr_send_prompt (fallback path)");
	const send = await sendTool.execute(
		"t",
		{ target: paneId, text: "Reply with exactly one word: pong" },
		undefined,
	);
	check(send.isError !== true, `send ok (isError=${send.isError})`);

	console.log("\n[pong] 4. poll read until the answer appears");
	let text = "";
	for (let i = 0; i < 60; i++) {
		const r = await herdr(
			[
				"agent",
				"read",
				paneId,
				"--source",
				"recent",
				"--lines",
				"40",
				"--format",
				"text",
			],
			{ timeoutMs: 15_000, textOk: true },
		);
		text = r.ok ? String(extractText(r.data) ?? "") : text;
		if (/pong/i.test(text)) break;
		await sleep(2_000);
	}
	console.log("    --- tail of response ---");
	console.log(
		text
			.split("\n")
			.slice(-8)
			.map((l) => "    " + l)
			.join("\n"),
	);
	check(/pong/i.test(text), "5. response contains 'pong' (AC2)");
} finally {
	if (paneId) {
		console.log("\n[pong] cleanup");
		const c = await herdr(["pane", "close", paneId], { timeoutMs: 10_000 });
		check(c.ok, `closed ${paneId}`);
	}
}

console.log(
	`\n${fail === 0 ? "✅ ALL PASS" : "❌ SOME FAILED"} (${pass}/${pass + fail})`,
);
process.exit(fail === 0 ? 0 : 1);
