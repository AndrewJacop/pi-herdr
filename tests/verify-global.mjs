// Verify the GLOBAL install: a plain `pi` (NO -e) spawned via Node (literal
// cmd /c) should auto-load the globally-installed pi-herdr extension and
// therefore self-report — i.e. its footer shows "herdr:" and its status
// transitions working -> done instead of sticking.
//
// Run: node tests/verify-global.mjs   (requires a running herdr session)

import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { piArgv } from "./_platform.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url);
const herdr = (await jiti.import(join(ROOT, "src/herdr.ts"), { parent: ROOT }))
	.herdr;
const extractText = (
	await jiti.import(join(ROOT, "src/env.ts"), { parent: ROOT })
).extractText;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const statusOf = async (pane) => {
	const r = await herdr(["agent", "get", pane], { timeoutMs: 8_000 });
	if (!r.ok) return "ERR";
	const a = r.data?.agent ?? r.data;
	return a?.agent_status ?? "?";
};
const visibleTail = async (pane) => {
	const r = await herdr(
		[
			"agent",
			"read",
			pane,
			"--source",
			"visible",
			"--lines",
			"8",
			"--format",
			"text",
		],
		{
			timeoutMs: 10_000,
			textOk: true,
		},
	);
	return extractText(r.data).slice(-300);
};

const check = (c, m) => {
	console.log((c ? "  ✓ " : "  ✗ ") + m);
	if (!c) process.exitCode = 1;
};

// 1. spawn a PLAIN pi (no -e) via Node so argv is passed literally (platform preset).
const start = await herdr(
	["agent", "start", "verify-global", "--no-focus", "--", ...piArgv()],
	{
		timeoutMs: 20_000,
	},
);
const pane = start.data?.agent?.pane_id;
check(!!pane, `plain pi spawned (no -e): ${pane}`);
if (!pane) process.exit(1);

try {
	console.log("waiting for boot (idle/done)...");
	let booted = false;
	for (let i = 0; i < 45; i++) {
		const s = await statusOf(pane);
		if (s === "idle" || s === "done") {
			booted = true;
			break;
		}
		await sleep(2_000);
	}
	check(booted, "booted to idle/done");

	// 2. Does the footer show "herdr:" => the global extension loaded?
	const tail = await visibleTail(pane);
	console.log(
		"    footer tail:",
		JSON.stringify(tail.replace(/\s+/g, " ").trim()),
	);
	check(
		/herdr:/i.test(tail),
		'pane footer shows "herdr:" => global extension auto-loaded',
	);

	// 3. Send a short task and confirm working -> done (not stuck).
	await herdr(["agent", "send", pane, "Reply with one word: ready"], {
		timeoutMs: 15_000,
	});
	await herdr(["pane", "send-keys", pane, "Enter"], { timeoutMs: 15_000 });
	console.log("watching status through the turn...");
	let sawWorking = false;
	let settled = false;
	for (let i = 0; i < 90; i++) {
		const s = await statusOf(pane);
		if (s === "working") sawWorking = true;
		if ((s === "done" || s === "idle") && sawWorking) {
			settled = true;
			console.log(`    transitioned working -> ${s} (t~${i * 2}s)`);
			break;
		}
		await sleep(2_000);
	}
	check(sawWorking, "self-reported WORKING during the turn");
	check(settled, "self-reported DONE after the turn (NOT stuck on working)");
} finally {
	await herdr(["pane", "close", pane], { timeoutMs: 10_000 });
	console.log("cleanup done");
}
