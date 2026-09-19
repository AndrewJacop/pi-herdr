// Verify the GLOBAL install: spawn a PLAIN `pi` (no -e) and confirm it
// (a) loaded pi-herdr (footer shows "herdr:") and (b) self-reports working->done
// reliably (not stuck on working). Requires a running herdr session.
//
// Run: node tests/globalprobe.mjs

import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { piArgv } from "./_platform.mjs";

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
const visibleTail = async (pane, n = 6) => {
	const r = await herdr(
		[
			"agent",
			"read",
			pane,
			"--source",
			"visible",
			"--lines",
			String(n),
			"--format",
			"text",
		],
		{ timeoutMs: 8_000, textOk: true },
	);
	if (!r.ok) return "";
	const t =
		r.data?.read?.text ??
		r.data?.text ??
		(typeof r.data === "string" ? r.data : JSON.stringify(r.data));
	return t.split(/\r?\n/).slice(-n).join("\n");
};

let pass = 0,
	fail = 0;
const check = (c, m) => {
	pass += c ? 1 : 0;
	fail += c ? 0 : 1;
	console.log((c ? "  ✓ " : "  ✗ ") + m);
};

// PLAIN pi — NO -e. Relies entirely on the global install.
const start = await herdr(
	["agent", "start", "global-probe", "--no-focus", "--", ...piArgv()],
	{ timeoutMs: 20_000 },
);
const pane = start.data?.agent?.pane_id;
console.log("spawned plain pi:", pane, "ok:", start.ok);
if (!pane) process.exit(1);

try {
	console.log("--- wait for boot (idle) ---");
	let booted = false;
	for (let i = 0; i < 60; i++) {
		if ((await statusOf(pane)) === "idle") {
			booted = true;
			break;
		}
		await new Promise((r) => setTimeout(r, 2_000));
	}
	check(booted, "booted to idle");

	// (a) Did it load pi-herdr globally? Footer should show "herdr:".
	const footer = await visibleTail(pane, 8);
	const loaded = /herdr:/i.test(footer);
	check(
		loaded,
		`global pi-herdr loaded (footer shows herdr:)\n      footer: ${footer.replace(/\n/g, " | ").slice(-160)}`,
	);

	console.log("--- send prompt ---");
	await herdr(["agent", "prompt", pane, "Reply with exactly one word: pong"], {
		timeoutMs: 15_000,
	});

	// (b) self-report: working -> done, reliably (not stuck on working).
	let sawWorking = false,
		reachedDone = false;
	for (let i = 0; i < 150; i++) {
		const s = await statusOf(pane);
		if (s === "working") sawWorking = true;
		if ((s === "done" || s === "idle") && sawWorking) {
			reachedDone = true;
			console.log(`    reached ${s} after working (t=${i * 2}s)`);
			break;
		}
		if (i % 5 === 0) console.log(`    t=${i * 2}s status=${s}`);
		await new Promise((r) => setTimeout(r, 2_000));
	}
	check(sawWorking, "reported WORKING during the turn");
	check(reachedDone, "reported DONE after the turn (NOT stuck on working)");
} finally {
	await herdr(["pane", "close", pane], { timeoutMs: 10_000 });
}

console.log(
	`\n${fail === 0 ? "✅ ALL PASS" : "❌ SOME FAILED"} (${pass}/${pass + fail})`,
);
process.exit(fail === 0 ? 0 : 1);
