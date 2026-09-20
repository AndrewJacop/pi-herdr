// Live round-trip for the open message channel (issue 05): two agents spawned
// by the spawn engine, A messages B with herdr_message_agent, B replies to
// A's `from` label with herdr_message_agent, and A's session result (the
// exact final assistant message) carries the reply envelope — agent ↔ agent,
// no broker, no parent relay.
//
// Hermetic-ish: temp project dir with pinned settings (à la spawn-live). The
// children load the dev-tree message tool via tests/fixtures/message-child.ts
// (-e), because a spawned pi auto-loads the globally INSTALLED pi-herdr
// (0.5.x — no message tool yet). Both children are interactive-stance: an
// autonomous child would auto-exit on its first settle and be gone before the
// reply lands.
//
// Run: node tests/message-live.mjs   (after starting a `herdr` session)

import { createJiti } from "jiti";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// temp project with pinned settings; chdir so defaultLoad + child cwd land here
const tmp = mkdtempSync(join(tmpdir(), "pi-herdr-message-live-"));
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
const messageTool = await jiti.import(join(ROOT, "src/tools/message.ts"), {
	parent: ROOT,
});

const tools = [];
const mockPi = { registerTool: (d) => tools.push(d), on: () => {} };
agentsTool.registerAgents(mockPi);
resultTool.registerResultTool(mockPi);
messageTool.registerMessageTool(mockPi);
const spawnTool = tools.find((t) => t.name === "herdr_spawn_agent");
const getResult = tools.find((t) => t.name === "herdr_get_agent_result");
const messageAgent = tools.find((t) => t.name === "herdr_message_agent");
if (!spawnTool || !getResult || !messageAgent) {
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

// Interactive stance — the panes must survive their first settle for the
// reply to land. Cleaned up (pane close) in the finally block. The children
// load the dev-tree message tool via the fixture (-e) because the globally
// installed pi-herdr (0.5.x) has no message tool. Inline definitions (no
// `type`): agent_args only exists there, and the task needs no
// general-purpose prompt.
const CHILD_ARGS = ["-e", join(ROOT, "tests", "fixtures", "message-child.ts")];

const spawned = [];
async function spawnChild(name, prompt) {
	const r = await spawnTool.execute(
		`msg-live-${name}`,
		{
			agent: { name, interactive: true, agent_args: CHILD_ARGS },
			prompt,
		},
		undefined,
	);
	const d = r.details ?? {};
	if (!r.isError && d.paneId) spawned.push(d.paneId);
	return d;
}

const herdrCli = await jiti.import(join(ROOT, "src/herdr.ts"), { parent: ROOT });

try {
	console.log("[message-live] 1. spawn B (replier), wait until settled-idle");
	const b = await spawnChild(
		"ml-b",
		"You are a message replier. Incoming messages arrive as " +
			'<agent-message from="…" to="…">text</agent-message> prompts. ' +
			"When a message contains the word ping, use the herdr_message_agent tool " +
			"to send exactly: pong — with target set to the message's from attribute. " +
			"Then reply with just: replied. For any other message, reply with just: waiting.",
	);
	check(!!b.paneId, `B spawned (pane: ${b.paneId}, handle: ${b.name})`);
	if (!b.paneId) throw new Error(b.startError ?? "B spawn failed");

	// B must be booted AND have settled its first turn before A pings it —
	// otherwise A's message resolves to a pane whose TUI input isn't ready,
	// or worse, resolves fine but B's first-turn output confuses the reply.
	const bSettled = await getResult.execute(
		"b-settle",
		{ target: b.name, wait: 180_000 },
		undefined,
	);
	check(
		bSettled.details?.status === "done",
		`B settled its boot turn (status: ${bSettled.details?.status})`,
	);

	console.log("[message-live] 2. spawn A (sender)");
	const a = await spawnChild(
		"ml-a",
		"Use the herdr_message_agent tool to send the message ping to the agent named " +
			`"${b.name}". Then end your turn. Later a reply will arrive as an ` +
			'<agent-message from="…" to="…">…</agent-message> prompt — when it does, ' +
			"repeat its FULL envelope text verbatim and nothing else.",
	);
	check(!!a.paneId, `A spawned (pane: ${a.paneId}, handle: ${a.name})`);
	if (!a.paneId) throw new Error(a.startError ?? "A spawn failed");

	console.log("[message-live] 3. ride the round-trip through A's session");
	// A's turns: (1) send ping → settle; (2) B's reply arrives injected →
	// A echoes the envelope → settle. The final assistant message in A's
	// parent-owned session file is the proof.
	let text = "";
	let lastStatus = "";
	for (let i = 0; i < 90 && !text.includes("pong"); i++) {
		await new Promise((r) => setTimeout(r, 2_000));
		const r = await getResult.execute(
			"a-result",
			{ target: a.name, wait: 10_000 },
			undefined,
		);
		lastStatus = r.details?.status ?? lastStatus;
		text = `${r.details?.result ?? ""}\n${r.content?.[0]?.text ?? ""}`;
	}
	check(text.includes("pong"), `A's session carries B's reply (status: ${lastStatus})`);
	check(
		/<agent-message[^>]*from="ml-b"/.test(text),
		'the reply arrived enveloped, from="ml-b" (spawner-declared identity)',
	);

	console.log("\n[message-live] receipt probe: parent messages B directly");
	const probe = await messageAgent.execute(
		"probe",
		{ target: b.name, text: "ping" },
		undefined,
	);
	check(
		probe.details?.delivery === "message" && probe.details?.delivered === true,
		`receipt shape ok (delivery: ${probe.details?.delivery}, state: ${probe.details?.state})`,
	);
} catch (e) {
	fail++;
	console.error(`  ✗ unexpected: ${e.message}`);
} finally {
	for (const paneId of spawned) {
		await herdrCli.herdr(["pane", "close", paneId], { timeoutMs: 10_000 }).catch(
			() => {},
		);
	}
}

console.log(
	`\n${fail === 0 ? "✅ ALL PASS" : "❌ SOME FAILED"} (${pass}/${pass + fail})`,
);
process.exit(fail === 0 ? 0 : 1);
