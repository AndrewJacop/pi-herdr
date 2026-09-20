// Live integration test for the v0.6 session modes (issue 09), run against a
// real herdr session + real pi + a real model:
//
//   fork         — a fabricated parent conversation carries a distinctive
//                  fact; the child spawned with `fork: true` answers a
//                  question about it WITHOUT being told in its prompt (the
//                  copy rides the session file, not the prompt).
//   lineage-only — the child's session file carries the `parentSession`
//                  header link and ZERO copied turns (its own prompt is the
//                  first message after the header).
//
// Hermetic-ish: runs in a temp project dir with its own .pi/herdr.json.
//
// Run: node tests/modes-live.mjs   (after starting a `herdr` session)

import { createJiti } from "jiti";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// temp project with pinned settings; chdir so defaultLoad + child cwd land here
const tmp = mkdtempSync(join(tmpdir(), "pi-herdr-modes-live-"));
mkdirSync(join(tmp, ".pi"), { recursive: true });
writeFileSync(
	join(tmp, ".pi", "herdr.json"),
	JSON.stringify({
		agents_kill_switch: false,
		max_parallel_agents: 3,
		max_spawn_depth: 2,
		default_kind: "pi",
	}),
);
process.chdir(tmp);

const jiti = createJiti(import.meta.url);
const agentsTool = await jiti.import(join(ROOT, "src/tools/agents.ts"), {
	parent: ROOT,
});
const resultTool = await jiti.import(join(ROOT, "src/tools/result.ts"), {
	parent: ROOT,
});
const sf = await jiti.import(join(ROOT, "src/sessionfile.ts"), {
	parent: ROOT,
});

const tools = [];
const mockPi = { registerTool: (d) => tools.push(d), on: () => {} };
agentsTool.registerAgents(mockPi);
resultTool.registerResultTool(mockPi);
const spawnTool = tools.find((t) => t.name === "herdr_spawn_agent");
const getResult = tools.find((t) => t.name === "herdr_get_agent_result");
if (!spawnTool || !getResult) {
	console.error("✗ tools not registered");
	process.exit(1);
}

let pass = 0,
	fail = 0;
const check = (c, m) => {
	pass += c ? 1 : 0;
	fail += c ? 0 : 1;
	console.log((c ? "  ✓ " : "  ✗ ") + m);
};

// The fabricated parent conversation — a valid pi session file with one
// distinctive fact the child must recall WITHOUT being told in its prompt.
// Assistant messages carry the fields pi's interactive footer reads
// (addUsageToTotals reads message.usage.input/.output/.cacheRead/.cacheWrite/
// .cost.total unguarded on every assistant message) — a real pi session
// always has them, and the fork copy stays verbatim, so the fixture must too.
const SECRET = "Zaruvian-7391";
const ts = new Date().toISOString();
const assistantMsg = (text) => ({
	role: "assistant",
	content: [{ type: "text", text }],
	usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, cost: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
	model: "test-model",
	provider: "test-provider",
	stopReason: "stop",
});
const parentPath = join(sf.sessionsDirFor(tmp), `modes-live-parent-${Date.now()}.jsonl`);
mkdirSync(sf.sessionsDirFor(tmp), { recursive: true });
const parentEntries = [
	{
		type: "session",
		version: 3,
		id: `modes-live-parent-${Date.now()}`,
		timestamp: ts,
		cwd: tmp,
	},
	{
		type: "message",
		id: "pm1",
		parentId: null,
		timestamp: ts,
		message: {
			role: "user",
			content: [{ type: "text", text: `Remember this for later: the name of the wizard is ${SECRET}. Just acknowledge.` }],
		},
	},
	{
		type: "message",
		id: "pm2",
		parentId: "pm1",
		timestamp: ts,
		message: assistantMsg("Acknowledged — I will remember the wizard's name."),
	},
	{
		type: "message",
		id: "pm3",
		parentId: "pm2",
		timestamp: ts,
		message: {
			role: "user",
			content: [{ type: "text", text: "Also, what color is the sky on a clear day?" }],
		},
	},
	{
		type: "message",
		id: "pm4",
		parentId: "pm3",
		timestamp: ts,
		message: assistantMsg("Blue, on a clear day."),
	},
];
writeFileSync(parentPath, parentEntries.map((e) => JSON.stringify(e)).join("\n"));

// The mock orchestrator ctx: the tool threads the parent session path from
// ctx.sessionManager.getSessionFile() — exactly what a real pi provides.
const ctx = {
	mode: "tui",
	hasUI: false,
	cwd: tmp,
	sessionManager: { getSessionFile: () => parentPath },
	model: undefined,
	modelRegistry: undefined,
	ui: {},
};

try {
	// ---- fork: the child knows the parent conversation without being told
	console.log("[live] fork — child answers a question about the parent conversation");
	const forkName = `forklive-${Date.now()}`;
	const r = await spawnTool.execute(
		"live-fork",
		{
			type: "general-purpose",
			name: forkName,
			prompt:
				"What is the name of the wizard mentioned earlier in this conversation? Reply with ONLY the name — no other words. If you cannot find it anywhere in this conversation, reply NONE.",
			fork: true,
			wait: 240_000,
		},
		undefined,
		undefined,
		ctx,
	);
	const d = r.details ?? {};
	check(r.isError !== true, `fork spawn ok (isError=${r.isError}; ${String(r.content?.[0]?.text ?? "").slice(0, 200)})`);
	check(d.session_mode === "fork", `mode selected + reported: ${d.session_mode}`);
	check(typeof d.sessionPath === "string" && d.sessionPath.startsWith(sf.sessionsDirFor(tmp)), `session file under the child cwd's pi sessions dir (${d.sessionPath})`);

	if (typeof d.sessionPath === "string") {
		// the seeded file itself carries the copied conversation
		const seeded = readFileSync(d.sessionPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
		const copiedCount = seeded.filter((e) => String(e.id).startsWith("pm")).length;
		check(
			seeded[0].type === "session" && seeded[0].version === 3 && seeded[0].parentSession === parentPath,
			"seeded header: v3 with the parentSession link",
		);
		check(
			seeded.some((e) => e.type === "message" && JSON.stringify(e.message).includes(SECRET)),
			"the copied conversation carries the secret (the prompt did not)",
		);
		check(
			seeded.slice(0, 1 + copiedCount).every((e) => e.type === "session" || e.type === "message"),
			"the SEEDED prefix (header + copies) carries no session-entry noise (the child's own boot entries follow it)",
		);

		// pull the result: the child must answer with the secret, unprompted
		const res = await getResult.execute("live-fork-result", { target: forkName, wait: 150_000 });
		const v = res.details ?? {};
		check(v.source === "session-jsonl", `result from the session JSONL (${v.source})`);
		if (v.status === "done") {
			const text = String(v.result ?? "");
			check(
				text.includes(SECRET) && !text.includes("NONE"),
				`forked child recalled the parent-conversation fact unprompted (${JSON.stringify(text.slice(0, 80))})`,
			);
		} else {
			check(false, `child did not settle done (status: ${v.status}) ${v.error?.errorMessage ?? ""} — rerun`);
		}
	}

	// ---- lineage-only: header link, zero copied turns
	console.log("[live] lineage-only — header link, zero copied turns");
	const linName = `linlive-${Date.now()}`;
	const r2 = await spawnTool.execute(
		"live-lineage",
		{
			prompt: "Reply with exactly: acknowledged.",
			name: linName,
			agent: { name: linName, session_mode: "lineage-only" },
			wait: 240_000,
		},
		undefined,
		undefined,
		ctx,
	);
	const d2 = r2.details ?? {};
	check(r2.isError !== true, `lineage-only spawn ok (isError=${r2.isError}; ${String(r2.content?.[0]?.text ?? "").slice(0, 200)})`);
	check(d2.session_mode === "lineage-only", `mode selected + reported: ${d2.session_mode}`);
	if (typeof d2.sessionPath === "string") {
		// AT SPAWN TIME the file is header-only; by result time the child's own
		// turn follows. pi flushes the prompt when the turn starts, so poll
		// briefly for a message entry before reading (no fixed sleep).
		await getResult.execute("live-lin-result", { target: linName, wait: 150_000 });
		let entries = [];
		for (let i = 0; i < 30; i++) {
			entries = readFileSync(d2.sessionPath, "utf8")
				.trim()
				.split("\n")
				.map((l) => JSON.parse(l));
			if (entries.some((e) => e.type === "message")) break;
			await new Promise((r) => setTimeout(r, 500));
		}
		check(
			entries[0].type === "session" && entries[0].parentSession === parentPath,
			"header carries the parentSession link",
		);
		const firstUser = entries.find((e) => e.type === "message" && e.message.role === "user");
		const text = JSON.stringify(firstUser?.message ?? "");
		check(
			text.includes("acknowledged") && !text.includes(SECRET),
			`ZERO copied turns — the first user message is the child's own prompt (${text.slice(0, 80)})`,
		);
	}
} catch (e) {
	check(false, `unexpected: ${e?.message ?? e}`);
} finally {
	try {
		rmSync(tmp, { recursive: true, force: true });
	} catch {
		/* best-effort */
	}
}

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ SOME FAILED"} (${pass}/${pass + fail})`);
process.exit(fail === 0 ? 0 : 1);
