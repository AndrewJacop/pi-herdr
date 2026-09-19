// Full-round validation of ask-user BLOCKED handling through the KEPT surface
// (v0.6 surface cut: herdr_delegate is gone; the composition is spawn →
// wait → read, and the relay is send_keys), against REAL spawned `pi`
// sessions loaded with the LOCAL extension (`-e <abs>/src/index.ts`). Runs
// the edited modules via jiti, so this exercises the current code paths.
//
// Flow: herdr_spawn_agent (background, ask_user prompt) → wait until BLOCKED
// (herdr_wait_agent — validates self-report) → read the question
// (herdr_read_agent) → answer the overlay by key navigation
// (herdr_send_keys — typed text never reaches an option list) → wait idle →
// read the final line and check the agent used the answer.
//
// Run: node tests/blocked.mjs   (requires a running herdr session + `pi` on PATH)

import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";

/** Fresh temp cwd — a reused one leaks the previous child's session context
 * into the next run. */
const freshCwd = () => mkdtempSync(join(tmpdir(), "pi-herdr-blocked-"));

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url);
const agentsTool = await jiti.import(join(ROOT, "src/tools/agents.ts"), {
	parent: ROOT,
});
const orch = await jiti.import(join(ROOT, "src/tools/orchestration.ts"), {
	parent: ROOT,
});
const { herdr } = await jiti.import(join(ROOT, "src/herdr.ts"), {
	parent: ROOT,
});

const tools = [];
const mockPi = { registerTool: (d) => tools.push(d), on: () => {} };
agentsTool.registerAgents(mockPi);
orch.registerOrchestration(mockPi);
const tool = (name) => {
	const t = tools.find((t) => t.name === name);
	if (!t) throw new Error(`tool not registered: ${name}`);
	return t;
};

// A neutral cwd so the project's package.json `pi.extensions` does NOT
// auto-load a second copy of pi-herdr alongside the global install
// (tool-name collision). The child loads the GLOBAL @andrewjacop/pi-herdr for
// self-report; the spawn logic runs in THIS harness via the jiti import.
const CWD = freshCwd();

const ASK_PROMPT = [
	"You MUST call the ask_user tool right now to ask the user this question:",
	"  'What is your favorite color?'",
	"Pass the options exactly and in this order: Red, Blue, Green — and",
	"allowFreeform: true. Do not guess an answer. Block until the user answers.",
	"After you receive the answer, reply with EXACTLY this single line and",
	"nothing else:",
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

const watchdog = setTimeout(() => {
	console.log("WATCHDOG");
	process.exit(2);
}, 300_000);

try {
	console.log("[blocked] 1. herdr_spawn_agent (background, ask_user prompt)");
	const name = `blocked-relay-${Date.now()}`;
	const res = await tool("herdr_spawn_agent").execute(
		"spawn",
		{ name, prompt: ASK_PROMPT, cwd: CWD },
		undefined,
	);
	const paneId = res.details?.paneId ?? null;
	check(res.isError !== true, `spawn ok (isError=${res.isError})`);
	check(!!paneId, `paneId present (${paneId})`);
	if (!paneId) throw new Error("no pane id");

	console.log("\n[blocked] 2. herdr_wait_agent (status: blocked)");
	const w = await tool("herdr_wait_agent").execute(
		"wait-blocked",
		{ target: paneId, status: "blocked", timeoutMs: 240_000 },
		undefined,
	);
	check(!w.isError, "agent reached BLOCKED (self-report through the wait tool)");

	console.log("\n[blocked] 3. herdr_read_agent (the question)");
	const q = await tool("herdr_read_agent").execute(
		"read-q",
		{ target: paneId, source: "recent", lines: 60 },
		undefined,
	);
	const qText = q.content?.[0]?.text ?? "";
	check(!q.isError, "read ok while blocked");
	check(
		/favorite color/i.test(qText),
		"the question text is readable (not treated as an answer)",
	);

	console.log(
		"\n[blocked] 4. herdr_send_keys — answer the overlay (Blue = down×1 + Enter)",
	);
	// Empirically validated overlay semantics: focus starts on option 1 — bare
	// Enter submits it; `down` first selects option 2. Typed text does NOT
	// reach the option list.
	const keys = await tool("herdr_send_keys").execute(
		"answer",
		{ target: paneId, keys: ["down", "Enter"] },
		undefined,
	);
	check(!keys.isError, "keys sent to the pane (option 2: Blue)");

	console.log("\n[blocked] 5. herdr_wait_agent (settle -> idle)");
	const settle = await tool("herdr_wait_agent").execute(
		"wait-idle",
		{ target: paneId, status: "idle", timeoutMs: 240_000 },
		undefined,
	);
	check(!settle.isError, "agent settled after the answer");

	console.log("\n[blocked] 6. herdr_read_agent (the answer)");
	await sleep(1500); // let the response render before reading
	const a = await tool("herdr_read_agent").execute(
		"read-a",
		{ target: paneId, source: "recent", lines: 60 },
		undefined,
	);
	const aText = a.content?.[0]?.text ?? "";
	console.log(
		"    --- tail of response ---\n" +
			aText
				.split("\n")
				.filter(Boolean)
				.slice(-6)
				.map((l) => "      " + l)
				.join("\n"),
	);
	check(!a.isError, "final read ok");
	check(
		/the color is blue/i.test(aText),
		'agent used the answer ("The color is Blue")',
	);

	await herdr(["pane", "close", paneId], { timeoutMs: 10_000 }).catch(() => {});
} catch (e) {
	console.error("threw:", e);
	fail += 1;
} finally {
	clearTimeout(watchdog);
	console.log(
		`\n${fail === 0 ? "✅ ALL PASS" : "❌ SOME FAILED"} (${pass} passed, ${fail} failed)`,
	);
	process.exit(fail === 0 ? 0 : 1);
}
