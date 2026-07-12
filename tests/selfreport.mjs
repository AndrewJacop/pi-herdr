// Verify self-report: spawn a pi WITH pi-herdr loaded (via -e), send it a prompt,
// and confirm herdr's agent_status transitions working -> idle RELIABLY (instead
// of sticking on "working" after the turn finishes). Requires a running herdr.
//
// Run: node tests/selfreport.mjs

import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url);
const herdr = (await jiti.import(join(ROOT, "src/herdr.ts"), { parent: ROOT }))
	.herdr;

const statusOf = async (pane) => {
	const r = await herdr(["agent", "get", pane], { timeoutMs: 8_000 });
	if (!r.ok) return `ERR:${r.error.code}`;
	const a = r.data?.agent ?? r.data;
	return a?.agent_status ?? "?";
};

// Spawn a pi that loads this extension so it self-reports.
const start = await herdr(
	[
		"agent",
		"start",
		"sr-probe",
		"--no-focus",
		"--",
		"cmd",
		"/c",
		"pi",
		"-e",
		"D:/Me/pi-herdr/src/index.ts",
	],
	{ timeoutMs: 20_000 },
);
const pane = start.data?.agent?.pane_id;
console.log("spawned pane:", pane, "ok:", start.ok);
if (!pane) process.exit(1);

let pass = 0,
	fail = 0;
const check = (c, m) => {
	pass += c ? 1 : 0;
	fail += c ? 0 : 1;
	console.log((c ? "  ✓ " : "  ✗ ") + m);
};

try {
	console.log("--- wait for boot (idle) ---");
	let booted = false;
	for (let i = 0; i < 60; i++) {
		const s = await statusOf(pane);
		if (s === "idle") {
			booted = true;
			break;
		}
		await new Promise((r) => setTimeout(r, 2_000));
	}
	check(booted, "reached idle after boot");

	console.log("--- send prompt + enter ---");
	await herdr(["agent", "send", pane, "Reply with exactly one word: pong"], {
		timeoutMs: 15_000,
	});
	await herdr(["pane", "send-keys", pane, "Enter"], { timeoutMs: 15_000 });

	console.log("--- watch status through the turn (self-reported) ---");
	let sawWorking = false;
	let reachedIdle = false;
	for (let i = 0; i < 120; i++) {
		const s = await statusOf(pane);
		if (s === "working") sawWorking = true;
		// herdr maps a self-reported idle-after-working to terminal "done".
		if ((s === "idle" || s === "done") && sawWorking) {
			reachedIdle = true;
			console.log(
				`    reached ${s} after seeing working (t=${i * 2}s) — not stuck`,
			);
			break;
		}
		if (i % 5 === 0) console.log(`    t=${i * 2}s status=${s}`);
		await new Promise((r) => setTimeout(r, 2_000));
	}
	check(sawWorking, "self-reported WORKING during the turn");
	check(
		reachedIdle,
		"self-reported IDLE/DONE after the turn (NOT stuck on working)",
	);
} finally {
	await herdr(["pane", "close", pane], { timeoutMs: 10_000 });
	console.log("cleanup done");
}

console.log(
	`\n${fail === 0 ? "✅ ALL PASS" : "❌ SOME FAILED"} (${pass}/${pass + fail})`,
);
process.exit(fail === 0 ? 0 : 1);
