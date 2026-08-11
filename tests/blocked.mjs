// Full-round validation of the ask-user BLOCKED handling in herdr_delegate,
// against REAL spawned `pi` sessions loaded with the LOCAL extension
// (`-e <abs>/src/index.ts`). Runs the edited module via jiti, so this exercises
// the new code paths (getAgentStatus, waitForBlockedResolved, onBlocked).
//
// Two modes:
//   1. onBlocked:"return" — delegate must return {blocked:true, question, paneId};
//      we then run the relay (send answer → wait idle → read) and check the
//      grandchild used the answer.
//   2. onBlocked:"wait"   — delegate blocks (no time bound) until the pane is
//      answered; we concurrently poll for `blocked` and inject the answer, then
//      check the delegate returned the grandchild's final answer.
//
// Run: node tests/blocked.mjs   (requires a running herdr session + `pi` on PATH)

import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";

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
const delegate = tools.find((t) => t.name === "herdr_delegate");
if (!delegate) {
	console.error("✗ herdr_delegate tool not registered");
	process.exit(1);
}

// A neutral cwd so the project's package.json `pi.extensions` does NOT auto-load
// a second copy of pi-herdr alongside the global install (tool-name collision).
// The child loads the GLOBAL @andrewjacop/pi-herdr for self-report (unchanged);
// the new delegate logic runs in THIS harness via the jiti import above.
const CWD = mkdtempSync(join(tmpdir(), "pi-herdr-blocked-"));

const ASK_PROMPT = [
	"You MUST call the ask_user tool right now to ask the user this question:",
	"  'What is your favorite color?'",
	"Pass allowFreeform: true and do NOT pass any options. Do not guess an answer.",
	"Block until the user answers. After you receive the answer, reply with EXACTLY",
	"this single line and nothing else:",
	"  The color is <answer>",
].join("\n");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const check = (c, m) => {
	pass += c ? 1 : 0;
	fail += c ? 0 : 1;
	console.log((c ? "  ✓ " : "  ✗ ") + m);
};

async function getStatus(target) {
	const r = await herdr(["agent", "get", target], {
		timeoutMs: 10_000,
		textOk: true,
	});
	if (!r.ok) return null;
	const d = r.data;
	const a = d && typeof d === "object" ? (d.agent ?? d) : null;
	return a?.agent_status ?? null;
}

async function waitStatus(target, want, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const s = await getStatus(target);
		if (want.includes(s)) return s;
		await sleep(1500);
	}
	return null;
}

async function readPane(target, lines = 60) {
	const r = await herdr(
		[
			"agent",
			"read",
			target,
			"--source",
			"recent",
			"--lines",
			String(lines),
			"--format",
			"text",
		],
		{ timeoutMs: 15_000, textOk: true },
	);
	if (!r.ok) return "";
	const d = r.data;
	if (typeof d === "string") return d;
	return d?.text ?? "";
}

async function closePane(target) {
	await herdr(["pane", "close", target], { timeoutMs: 10_000 }).catch(() => {});
}

// ===========================================================================
// MODE 1: onBlocked = "return"
// ===========================================================================
async function testReturnMode() {
	console.log('\n=== MODE 1: onBlocked === "return" ===');
	const name = `blocked-return-${Date.now()}`;
	const res = await delegate.execute(
		"return-call",
		{
			name,
			agent: "pi",
			cwd: CWD,
			onBlocked: "return",
			prompt: ASK_PROMPT,
			timeoutMs: 240_000,
		},
		undefined,
	);

	const det = res.details ?? {};
	console.log("    isError:", res.isError ?? false);
	console.log("    details.blocked:", det.blocked);
	console.log("    details.paneId:", det.paneId);
	check(
		res.isError === true,
		"return mode: result is an error (not a silent success)",
	);
	check(det.blocked === true, "return mode: details.blocked === true");
	check(!!det.paneId, `return mode: paneId present (${det.paneId})`);
	check(
		typeof det.question === "string" && det.question.length > 0,
		"return mode: question text captured (not treated as the answer)",
	);

	if (!det.paneId) {
		console.log("    (no paneId — aborting mode 1 relay)");
		return;
	}

	// The spawned agent must actually be BLOCKED right now (validates self-report).
	const st = await getStatus(det.paneId);
	console.log("    grandchild status after return:", st);
	check(st === "blocked", `return mode: grandchild is blocked (got "${st}")`);

	// Relay: inject the answer, wait for idle, read the final line.
	const inj = await herdr(["agent", "prompt", det.paneId, "Blue"], {
		timeoutMs: 15_000,
	});
	check(inj.ok, "return mode: relay injected answer (Blue) via agent prompt");
	const settled = await waitStatus(det.paneId, ["idle", "done"], 120_000);
	check(
		!!settled,
		`return mode: grandchild settled after answer (status "${settled}")`,
	);
	const out = await readPane(det.paneId);
	console.log("    --- grandchild final output (tail) ---");
	console.log(
		out
			.split("\n")
			.slice(-12)
			.map((l) => "      " + l)
			.join("\n"),
	);
	check(
		/the color is blue/i.test(out),
		'return mode: grandchild used the answer ("The color is Blue")',
	);

	await closePane(det.paneId);
}

// ===========================================================================
// MODE 2: onBlocked = "wait"  (default)
// ===========================================================================
async function testWaitMode() {
	console.log('\n=== MODE 2: onBlocked === "wait" (default) ===');
	const name = `blocked-wait-${Date.now()}`;

	// Concurrent injector: poll the named pane until it is BLOCKED, then answer.
	// This is the "human answers in the spawned pane" stand-in.
	const injector = (async () => {
		for (let i = 0; i < 180; i++) {
			await sleep(1500);
			const s = await getStatus(name);
			if (s === "blocked") {
				await sleep(800); // let the ask overlay fully settle
				const r = await herdr(["agent", "prompt", name, "Red"], {
					timeoutMs: 15_000,
				});
				return r.ok ? "injected" : "inject-failed";
			}
		}
		return "never-blocked";
	})();

	const res = await delegate.execute(
		"wait-call",
		{
			name,
			agent: "pi",
			cwd: CWD,
			onBlocked: "wait",
			prompt: ASK_PROMPT,
			timeoutMs: 300_000,
		},
		undefined,
	);
	const inj = await injector;

	const det = res.details ?? {};
	console.log("    isError:", res.isError ?? false);
	console.log("    details.wasBlocked:", det.wasBlocked);
	console.log("    injector:", inj);
	const text = res.content?.[0]?.text ?? "";
	console.log("    --- delegate response (tail) ---");
	console.log(
		text
			.split("\n")
			.slice(-12)
			.map((l) => "      " + l)
			.join("\n"),
	);

	check(
		inj === "injected",
		`wait mode: injector saw blocked & answered (${inj})`,
	);
	check(
		res.isError !== true,
		"wait mode: delegate returned success after the answer",
	);
	check(det.wasBlocked === true, "wait mode: details.wasBlocked === true");
	check(
		/the color is red/i.test(text),
		'wait mode: delegate returned the grandchild\'s final answer ("The color is Red")',
	);

	if (det.paneId) await closePane(det.paneId);
}

// ===========================================================================
await testReturnMode().catch((e) => {
	console.error("mode 1 threw:", e);
	fail += 1;
});
await testWaitMode().catch((e) => {
	console.error("mode 2 threw:", e);
	fail += 1;
});

console.log(
	`\n${fail === 0 ? "✅ ALL PASS" : "❌ SOME FAILED"} (${pass}/${pass + fail})`,
);
process.exit(fail === 0 ? 0 : 1);
