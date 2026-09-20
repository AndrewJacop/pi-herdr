// Verify the GLOBAL install: a plain `pi` (NO -e) spawned via Node (literal
// cmd /c) should auto-load the globally-installed pi-herdr extension and
// therefore self-report — i.e. its footer shows "herdr:" and its status
// transitions working -> done instead of sticking.
//
// Run: node tests/verify-global.mjs   (requires a running herdr session)

import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { startPlainPi } from "./_platform.mjs";

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

// 1. spawn a PLAIN pi (no -e) via the 0.9.0 launch path (pane split + agent
//    start --kind) so argv is literal and the global install auto-loads.
const started = await startPlainPi("verify-global");
const pane = started.ok ? started.paneId : undefined;
check(
	!!pane,
	`plain pi spawned (no -e): ${pane}${started.ok ? "" : ` — ${started.error?.message}`}`,
);
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

	// 2. Send a short task and confirm working -> done (not stuck).
	await herdr(["agent", "prompt", pane, "Reply with one word: ready"], {
		timeoutMs: 15_000,
	});
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

	// 3. The footer's "herdr:" segment renders from the agent_start/turn_end
	// hooks — only after a first turn, so this check runs post-turn.
	const tail = await visibleTail(pane);
	console.log(
		"    footer tail:",
		JSON.stringify(tail.replace(/\s+/g, " ").trim()),
	);
	check(
		/herdr:/i.test(tail),
		'pane footer shows "herdr:" => global extension auto-loaded',
	);
} finally {
	await herdr(["pane", "close", pane], { timeoutMs: 10_000 });
	console.log("cleanup done");
}
