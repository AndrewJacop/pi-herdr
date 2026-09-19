// Verify self-report: spawn a pi WITH pi-herdr loaded (via -e), send it a prompt
// (pane-level), and confirm herdr's agent_status transitions working -> idle/done
// RELIABLY (instead of sticking on "working" after the turn finishes).
// Requires a running herdr. The grandchild is launched via the extension's
// own `agent start --kind` path — self-report rides the pane env it carries.
//
// Run: node tests/selfreport.mjs

import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { spawnPiAgent, panePrompt, waitStatus } from "./_spawn.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url);
const { herdr } = await jiti.import(join(ROOT, "src/herdr.ts"), {
	parent: ROOT,
});

const statusOf = async (pane) => {
	const r = await herdr(["agent", "get", pane], { timeoutMs: 8_000 });
	if (!r.ok) return `ERR:${r.error.code}`;
	const a = r.data?.agent ?? r.data;
	return a?.agent_status ?? "?";
};

let pass = 0,
	fail = 0;
const check = (c, m) => {
	pass += c ? 1 : 0;
	fail += c ? 0 : 1;
	console.log((c ? "  ✓ " : "  ✗ ") + m);
};

// Neutral cwd so the local package.json does not auto-load a second copy of
// the extension alongside the explicit -e below.
const CWD = mkdtempSync(join(tmpdir(), "pi-herdr-selfreport-"));

// Spawn a pi that loads ONLY this local extension (-ne skips the user's global
// extension set, which includes the npm-published pi-herdr — loading both
// crashes pi on tool-name conflicts).
const spawned = await spawnPiAgent("sr-probe", {
	agentArgs: ["-ne", "-e", join(ROOT, "src", "index.ts")],
	cwd: CWD,
});
const pane = spawned.paneId;
console.log("spawned pane:", pane, spawned.error ? spawned.error.message : "");
if (!pane) process.exit(1);

try {
	console.log("--- wait for boot (idle) ---");
	const boot = await waitStatus(pane, ["idle", "done"], 120_000);
	check(!!boot, `reached idle/done after boot (got ${boot})`);

	console.log("--- send prompt pane-level (text + settled Enter) ---");
	const sent = await panePrompt(pane, "Reply with exactly one word: pong");
	check(sent.ok, "prompt submitted");

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
