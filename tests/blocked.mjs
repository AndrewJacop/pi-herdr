// Full-round validation of ask-user BLOCKED handling through the KEPT surface
// (v0.6 issue 04: herdr_wait_agent/herdr_read_agent retired — the composition
// is spawn → get_agent_result(wait) → herdr_read_pane, and the relay is
// send_keys), against REAL spawned `pi` sessions. Runs the edited modules via
// jiti, so this exercises the current code paths.
//
// Flow: herdr_spawn_agent (background, ask_user prompt) → herdr_get_agent_result
// (wait: blocked is terminal — validates self-report) → read the question
// (herdr_read_pane) → answer the overlay by key navigation (herdr_send_keys —
// typed text never reaches an option list) → herdr_get_agent_result (wait:
// done) → the EXACT final message from the child's session JSONL proves the
// answer was used. The autonomous child auto-exits on settle; the session
// file stays behind.
//
// Run: node tests/blocked.mjs   (requires a running herdr session + `pi` on PATH)

import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync, mkdtempSync } from "node:fs";

/** Fresh temp cwd — a reused one leaks the previous child's session context
 * into the next run. */
const freshCwd = () => mkdtempSync(join(tmpdir(), "pi-herdr-blocked-"));

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url);
const agentsTool = await jiti.import(join(ROOT, "src/tools/agents.ts"), {
	parent: ROOT,
});
const resultToolMod = await jiti.import(join(ROOT, "src/tools/result.ts"), {
	parent: ROOT,
});
const syncTool = await jiti.import(join(ROOT, "src/tools/sync.ts"), {
	parent: ROOT,
});
const tools = [];
const mockPi = { registerTool: (d) => tools.push(d), on: () => {} };
agentsTool.registerAgents(mockPi);
resultToolMod.registerResultTool(mockPi);
syncTool.registerPaneSync(mockPi);
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
}, 420_000);

try {
	console.log("[blocked] 1. herdr_spawn_agent (background, ask_user prompt)");
	const name = `blocked-relay-${Date.now()}`;
	const res = await tool("herdr_spawn_agent").execute(
		"spawn",
		{ name, agent: { name, kind: "pi" }, prompt: ASK_PROMPT, cwd: CWD },
		undefined,
	);
	const paneId = res.details?.paneId ?? null;
	check(res.isError !== true, `spawn ok (isError=${res.isError})`);
	check(!!paneId, `paneId present (${paneId})`);
	if (!paneId) throw new Error("no pane id");

	// NOTE: herdr 0.9.1 does not surface extension-reported blocked state in
	// `agent get` (selfreport gap, revisited with the status-projection ticket),
	// so the overlay is detected physically: poll the pane until the question
	// renders.
	console.log("\n[blocked] 2. wait for the ask-user overlay (poll herdr_read_pane)");
	let qText = "";
	for (let i = 0; i < 150 && !/favorite color/i.test(qText); i++) {
		await new Promise((r) => setTimeout(r, 2000));
		const q = await tool("herdr_read_pane").execute(
			"read-q",
			{ paneId, source: "recent", lines: 60 },
			undefined,
		);
		qText = q.content?.[0]?.text ?? "";
	}
	check(
		/favorite color/i.test(qText),
		"the question overlay is up and readable (not treated as an answer)",
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

	console.log("\n[blocked] 5. herdr_get_agent_result (wait — done, via the JSONL)");
	const a = await tool("herdr_get_agent_result").execute(
		"read-a",
		{ target: name, wait: 240_000 },
		undefined,
	);
	const v = a.details ?? {};
	check(
		v.status === "done",
		`agent finished (status: ${v.status}${v.error ? ` — ${v.error.errorMessage}` : ""})`,
	);
	check(
		v.source === "session-jsonl",
		`result sourced from the session JSONL (got ${v.source})`,
	);
	const aText = v.result ?? "";
	console.log(
		"    --- exact final message ---\n" +
			aText
				.split("\n")
				.filter(Boolean)
				.slice(-6)
				.map((l) => "      " + l)
				.join("\n"),
	);
	check(
		/the color is blue/i.test(aText),
		'agent used the answer ("The color is Blue") — exact from the session file',
	);
	check(
		typeof v.sessionPath === "string" &&
			existsSync(v.sessionPath),
		"session file retained after the autonomous auto-exit",
	);
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
