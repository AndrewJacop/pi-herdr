// Live end-to-end: reproduce the Appendix D ping -> pong flow through the real
// herdr.ts helper against a live herdr server + a spawned `pi` agent (AC2).
// Requires a running herdr session and a working model/API key for the spawned pi.
//
// Run: node tests/pong.mjs

import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url);
const mod = await jiti.import(join(ROOT, "src/herdr.ts"), { parent: ROOT });
const herdr = mod.herdr;
const extractText = (
	await jiti.import(join(ROOT, "src/env.ts"), { parent: ROOT })
).extractText;

let pass = 0,
	fail = 0;
const check = (c, m) => {
	pass += c ? 1 : 0;
	fail += c ? 0 : 1;
	console.log((c ? "  ✓ " : "  ✗ ") + m);
};
const rawText = (d) => {
	const t = extractText(d);
	return t.slice(-400);
};

const PANE = {};

try {
	console.log("[pong] 1. start pi agent (cmd /c pi)");
	const start = await herdr(
		["agent", "start", "pi-pong", "--no-focus", "--", "cmd", "/c", "pi"],
		{
			timeoutMs: 20_000,
		},
	);
	check(start.ok, `start ok (code=${start.error?.code})`);
	PANE.id = start.data?.agent?.pane_id;
	check(!!PANE.id, `pane: ${PANE.id}`);
	if (!PANE.id) throw new Error("no pane");

	console.log(
		"\n[pong] 2. wait for boot (idle), tolerating the 'unknown' window",
	);
	const boot = await herdr(
		["wait", "agent-status", PANE.id, "--status", "idle", "--timeout", "60000"],
		{
			timeoutMs: 70_000,
		},
	);
	check(boot.ok, `boot -> idle (code=${boot.error?.code})`);

	console.log("\n[pong] 3. send prompt + Enter");
	const send = await herdr(
		["agent", "send", PANE.id, "Reply with exactly one word: pong"],
		{
			timeoutMs: 15_000,
		},
	);
	check(send.ok, `send ok`);
	const enter = await herdr(["pane", "send-keys", PANE.id, "Enter"], {
		timeoutMs: 15_000,
	});
	check(enter.ok, `enter ok`);

	console.log("\n[pong] 4. trace the turn: working -> idle");
	await herdr(
		[
			"wait",
			"agent-status",
			PANE.id,
			"--status",
			"working",
			"--timeout",
			"30000",
		],
		{
			timeoutMs: 35_000,
		},
	);
	const idle = await herdr(
		[
			"wait",
			"agent-status",
			PANE.id,
			"--status",
			"idle",
			"--timeout",
			"120000",
		],
		{
			timeoutMs: 130_000,
		},
	);
	check(idle.ok, `turn complete -> idle (code=${idle.error?.code})`);

	console.log("\n[pong] 5. read response");
	const read = await herdr(
		[
			"agent",
			"read",
			PANE.id,
			"--source",
			"recent",
			"--lines",
			"40",
			"--format",
			"text",
		],
		{ timeoutMs: 15_000, textOk: true },
	);
	check(read.ok, `read ok (code=${read.error?.code})`);
	const text = rawText(read.data);
	console.log("    --- tail of response ---");
	console.log(
		text
			.split("\n")
			.map((l) => "    " + l)
			.join("\n"),
	);
	check(/pong/i.test(text), "response contains 'pong' (AC2)");
} finally {
	if (PANE.id) {
		console.log("\n[pong] cleanup");
		const c = await herdr(["pane", "close", PANE.id], { timeoutMs: 10_000 });
		check(c.ok, `closed ${PANE.id}`);
	}
}

console.log(
	`\n${fail === 0 ? "✅ ALL PASS" : "❌ SOME FAILED"} (${pass}/${pass + fail})`,
);
process.exit(fail === 0 ? 0 : 1);
