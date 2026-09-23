// E2E — the shipped experience (the gate the per-ticket live suites don't cover):
// ONE fresh interactive pi orchestrator with the globally-installed pi-herdr
// EXCLUDED (`-ne`) and the LOCAL dev tree loaded (`-e`), driven through real
// prompts so the MODEL discovers the 12-tool surface and chains it — the way a
// user session actually runs. Scenarios: surface discovery, spawn+pull, the
// message channel, interrupt→redirect, resume-from-gone, workflows (+ the
// completion push that wakes the orchestrator unprompted), fork inheritance,
// and the kill-switch refusal.
//
// Assertions never read TUI text: they come from the orchestrator's own
// session JSONL (tool calls + final answers — the substrate makes the
// orchestrator itself inspectable) and herdr fleet state.
//
// Run: node tests/e2e-live.mjs   (running herdr session + pi + model
//       credentials; ~25-35 min — every scenario is real LLM turns)

import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	existsSync,
	readdirSync,
	readFileSync,
	rmSync,
} from "node:fs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url);
const { herdr } = await jiti.import(join(ROOT, "src/herdr.ts"), { parent: ROOT });
const { sessionsDirFor, parseSessionEntries } = await jiti.import(
	join(ROOT, "src/sessionfile.ts"),
	{ parent: ROOT },
);
const { spawnPiAgent, waitStatus } = await jiti.import(
	join(ROOT, "tests/_spawn.mjs"),
	{ parent: ROOT },
);

// Forward slashes — the -e path is typed into a shell line.
const LOCAL_SRC = join(ROOT, "src/index.ts").replace(/\\/g, "/");
const ORCH = "e2e-orch";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// temp project with pinned settings; the orchestrator boots with cwd here, so
// its session file (and every child's) lands in pi's default dir for tmp.
const tmp = mkdtempSync(join(tmpdir(), "pi-herdr-e2e-"));
mkdirSync(join(tmp, ".pi"), { recursive: true });
const SETTINGS_OK = {
	agents_kill_switch: false,
	max_parallel_agents: 4,
	max_spawn_depth: 2,
	default_kind: "pi",
};
const writeSettings = (over) =>
	writeFileSync(
		join(tmp, ".pi", "herdr.json"),
		JSON.stringify({ ...SETTINGS_OK, ...over }),
	);
writeSettings({});

let pass = 0,
	fail = 0;
const check = (c, m) => {
	pass += c ? 1 : 0;
	fail += c ? 0 : 1;
	console.log(`  ${c ? "✓" : "✗"} ${m}`);
};
const section = (m) => console.log(`\n[${m}]`);

// --- orchestrator session file / entries ------------------------------------

let orchPath = null;
function resolveOrchPath() {
	if (orchPath && existsSync(orchPath)) return orchPath;
	const dir = sessionsDirFor(tmp);
	if (!existsSync(dir)) return null;
	// oldest jsonl wins: the orchestrator booted first; children (and their
	// files) can only come from its later turns.
	const files = readdirSync(dir)
		.filter((f) => f.endsWith(".jsonl"))
		.sort();
	if (!files.length) return null;
	orchPath = join(dir, files[0]);
	return orchPath;
}

function entryCount() {
	const p = resolveOrchPath();
	if (!p) return 0;
	return parseSessionEntries(readFileSync(p, "utf8")).entries.length;
}

function entriesFrom(n) {
	const p = resolveOrchPath();
	if (!p) return [];
	return parseSessionEntries(readFileSync(p, "utf8")).entries.slice(n);
}

const textOf = (entry) => {
	const m = entry?.message;
	if (!m || typeof m !== "object" || m.role !== "assistant") return "";
	const c = m.content;
	if (typeof c === "string") return c;
	if (!Array.isArray(c)) return "";
	return c
		.filter((b) => b?.type === "text" && typeof b.text === "string")
		.map((b) => b.text)
		.join("\n");
};

const answerOf = (entries) => {
	for (let i = entries.length - 1; i >= 0; i--) {
		const t = textOf(entries[i]);
		if (t) return t;
	}
	return "";
};

const toolsIn = (entries) => {
	const names = [];
	for (const e of entries) {
		const m = e?.message;
		if (!m || typeof m !== "object" || m.role !== "assistant") continue;
		if (!Array.isArray(m.content)) continue;
		for (const b of m.content) {
			if (b?.type === "toolCall" && typeof b.name === "string") names.push(b.name);
		}
	}
	return names;
};

const status = async () => {
	const r = await herdr(["agent", "get", paneId], { timeoutMs: 8_000 });
	const a = r.ok ? (r.data?.agent ?? r.data) : null;
	return a?.agent_status ?? null;
};

// --- driving the orchestrator ------------------------------------------------

let paneId = null;

/** Submit one prompt through herdr's own submit+wait machinery; on return the
 *  turn has settled. Retries the herdr-side `agent_prompt_stalled` case (the
 *  prompt landed before the TUI input was ready). */
async function submit(text, timeoutMs) {
	for (let attempt = 1; ; attempt++) {
		const r = await herdr(
			["agent", "prompt", paneId, text, "--wait", "--timeout", String(timeoutMs)],
			{ timeoutMs: timeoutMs + 30_000 },
		);
		if (r.ok) return true;
		const stalled = /stalled|NOT_STARTED/i.test(String(r.error?.message));
		if (!stalled || attempt >= 3) {
			console.log(`  (submit error: ${r.error?.code} ${r.error?.message})`);
			return false;
		}
		await sleep(5_000);
	}
}

/** One full turn: snapshot → submit → wait settled → return the new region. */
async function drive(text, { timeoutMs = 6 * 60_000 } = {}) {
	const before = entryCount();
	const ok = await submit(text, timeoutMs);
	const settled = ok && (await waitStatus(paneId, ["idle", "done"], timeoutMs));
	const region = entriesFrom(before);
	return { region, answer: answerOf(region), tools: toolsIn(region), settled };
}

/** Wait for a completion push to wake the orchestrator WITHOUT a manual prompt
 *  (issue 06/12 delivery), then for that turn to settle. [] if nothing came. */
async function waitPush(after, timeoutMs = 8 * 60_000) {
	const deadline = Date.now() + timeoutMs;
	let woke = false;
	while (Date.now() < deadline) {
		if ((await status()) === "working" || entryCount() > after) {
			woke = true;
			break;
		}
		await sleep(3_000);
	}
	if (!woke) return [];
	await waitStatus(paneId, ["idle", "done"], timeoutMs);
	return entriesFrom(after);
}

// --- pane hygiene (workflow-live house rule) ---------------------------------

async function cleanupPanes() {
	const r = await herdr(["pane", "list"], { timeoutMs: 10_000 }).catch(() => null);
	const panes = r?.ok ? (r.data?.panes ?? r.data?.result?.panes ?? []) : [];
	for (const p of panes) {
		const id = p?.pane_id ?? p?.id;
		if (id && typeof p.cwd === "string" && p.cwd.startsWith(tmp)) {
			await herdr(["pane", "close", id], { timeoutMs: 10_000 }).catch(() => {});
		}
	}
}

// --- the scenarios -----------------------------------------------------------

try {
	console.log("=== e2e: one fresh pi, global plugin excluded, local v0.6 loaded ===");
	console.log(`    orchestrator: pi -ne -e ${LOCAL_SRC}`);
	console.log(`    project: ${tmp}`);

	section("boot");
	const boot = await spawnPiAgent(ORCH, {
		agentArgs: ["-ne", "-e", LOCAL_SRC],
		cwd: tmp,
	});
	if (boot.error || !boot.paneId) {
		console.error(`  ✗ orchestrator failed to launch: ${boot.error?.message}`);
		process.exit(1);
	}
	paneId = boot.paneId;
	check(!!paneId, `orchestrator pane live (${paneId})`);
	const idle = await waitStatus(paneId, ["idle", "done"], 180_000);
	check(!!idle, `booted to idle (status: ${idle})`);
	// resolve the orchestrator's session file (pi writes its header on boot;
	// if not yet, the first drive's submit creates it and resolveOrchPath finds it)
	for (let i = 0; i < 40 && !resolveOrchPath(); i++) await sleep(3_000);
	check(!!resolveOrchPath(), `orchestrator session file exists (${orchPath ?? "none"})`);
	if (!idle) process.exit(1);

	// S1 — surface discovery: the model sees exactly the twelve
	section("S1 surface discovery");
	{
		const { answer } = await drive(
			"Without calling any tools: list the names of every herdr_* tool currently available to you, as a comma-separated list of exact tool names, nothing else.",
		);
		const twelve = [
			"herdr_spawn_agent",
			"herdr_save_agent",
			"herdr_get_agent_result",
			"herdr_message_agent",
			"herdr_interrupt_agent",
			"herdr_resume_agent",
			"herdr_list_agents",
			"herdr_run_workflow",
			"herdr_run_command",
			"herdr_read_pane",
			"herdr_wait_output",
			"herdr_send_keys",
		];
		const missing = twelve.filter((t) => !answer.includes(t));
		check(!missing.length, `all twelve tools visible to the model${missing.length ? ` (missing: ${missing.join(", ")})` : ""}`);
		check(
			!/herdr_spawn_agent_ex|herdr_wait_agent|herdr_read_agent|herdr_start_agent|herdr_close_pane/.test(answer),
			"no cut/legacy tool names leaked into the surface",
		);
		if (missing.length) console.log(`    answer: ${answer.slice(0, 300)}`);
	}

	// S2 — spawn + pull; child session file at the pi-default path
	section("S2 spawn + get_agent_result");
	{
		const { answer, tools } = await drive(
			"Use herdr_spawn_agent to spawn an agent named 'math-e2e' (kind 'pi', default autonomous stance) with prompt 'Reply with exactly: 42'. Then use herdr_get_agent_result on it (wait: 240000) and tell me the exact number it returned.",
		);
		check(tools.includes("herdr_spawn_agent"), "spawn tool used by the model");
		check(tools.includes("herdr_get_agent_result"), "result tool used by the model");
		check(answer.includes("42"), `answer carries the child's result ("${answer.slice(0, 120)}")`);
		const dir = sessionsDirFor(tmp);
		let files = 0;
		for (let i = 0; i < 20; i++) {
			files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".jsonl")).length : 0;
			if (files >= 2) break;
			await sleep(3_000);
		}
		check(files >= 2, `child session file at the pi-default path (${files} jsonl in the dir)`);
	}

	// S3 — the message channel: orchestrator ↔ child, LLM-driven both sides
	section("S3 message channel");
	{
		const { answer, tools } = await drive(
			"Use herdr_spawn_agent to spawn an agent named 'bob-e2e' (kind 'pi', interactive: true) with prompt: You are bob. When you receive an <agent-message> tag, reply to its sender using herdr_message_agent with exactly one word: pong. Then use herdr_message_agent to send bob the text 'ping', then use herdr_get_agent_result on bob (wait: 240000) and tell me exactly what bob replied with.",
			{ timeoutMs: 8 * 60_000 },
		);
		check(tools.includes("herdr_message_agent"), "message tool used by the model");
		check(/pong/i.test(answer), `round trip landed ("${answer.slice(0, 120)}")`);
	}

	// S4 — interrupt → stop-and-redirect
	section("S4 interrupt + redirect");
	{
		const { answer, tools } = await drive(
			"Use herdr_spawn_agent to spawn 'counter-e2e' (kind 'pi', interactive: true) with prompt 'Count from 1 to 30 aloud, a few numbers per reply. Keep counting until told to stop.' Check herdr_list_agents until counter-e2e is working, then use herdr_interrupt_agent on it, then use herdr_message_agent to send it: Stop counting. Reply with exactly: redirected — then herdr_get_agent_result on it (wait: 240000) and tell me what it replied.",
			{ timeoutMs: 9 * 60_000 },
		);
		check(tools.includes("herdr_interrupt_agent"), "interrupt tool used by the model");
		check(/redirected/i.test(answer), `stop-and-redirect worked ("${answer.slice(0, 120)}")`);
	}

	// S5 — resume: the gone S2 child, replayed conversation answers
	section("S5 resume from gone");
	{
		const after = entryCount();
		const { answer, tools } = await drive(
			"Earlier you spawned 'math-e2e'; it finished and its pane closed. Use herdr_resume_agent on it with message: Without redoing any work: what exact number did you reply with before? One word. The resume is background — when its completion is delivered to you, tell me the number.",
			{ timeoutMs: 6 * 60_000 },
		);
		check(tools.includes("herdr_resume_agent"), "resume tool used by the model");
		if (/42/.test(answer)) {
			check(true, "answer carried in the same turn");
		} else {
			const push = await waitPush(after);
			check(/42/.test(answerOf(push)), `resumed child answered from its replayed conversation ("${answerOf(push).slice(0, 120)}")`);
		}
	}

	// S6 + S8 — workflow run; the aggregated completion push wakes the orchestrator
	section("S6 workflow + S8 unprompted push");
	{
		const after = entryCount();
		const { tools } = await drive(
			"Use herdr_run_workflow to run this script:\n\nexport const meta = { name: 'e2e', description: 'two agents in parallel' }\nconst outs = await pipeline(['red', 'blue'], (c) => agent('Reply with exactly one word: ' + c, { label: 'say-' + c }))\nreturn { outs }\n\nThe tool returns immediately with a run id — do NOT poll, sleep, or check anything; the run's completion will be delivered to you on its own.",
			{ timeoutMs: 4 * 60_000 },
		);
		check(tools.includes("herdr_run_workflow"), "workflow tool used by the model");
		const push = await waitPush(after);
		check(push.length > 0, "completion push woke the orchestrator unprompted (issue 06/12 delivery)");
		if (!push.length) {
			// fallback: ask it to go look
			const nudge = await drive("Report the workflow run's result now.", { timeoutMs: 6 * 60_000 });
			check(/red/i.test(nudge.answer) && /blue/i.test(nudge.answer), `run result reported on request ("${nudge.answer.slice(0, 120)}")`);
		} else {
			const a = answerOf(push);
			check(/red/i.test(a) && /blue/i.test(a), `one aggregated result carried both answers ("${a.slice(0, 120)}")`);
		}
	}

	// S7 — fork: the child knows the parent conversation without being told
	section("S7 fork inheritance");
	{
		mkdirSync(join(tmp, ".pi", "agents"), { recursive: true });
		writeFileSync(
			join(tmp, ".pi", "agents", "fork-e2e.md"),
			"---\nname: fork-e2e\ndescription: e2e fork child — inherits the parent conversation\nsession-mode: fork\n---\nAnswer in one short sentence.",
		);
		const { answer, tools } = await drive(
			"Use herdr_spawn_agent to spawn the saved agent definition 'fork-e2e' (kind 'pi') with prompt: What was the FIRST thing I asked in this conversation? One short sentence, no tools. Then herdr_get_agent_result on it (wait: 300000) and tell me its exact answer.",
			{ timeoutMs: 9 * 60_000 },
		);
		check(tools.includes("herdr_spawn_agent"), "spawn from the saved definition worked");
		check(
			/tool|list|herdr_/i.test(answer),
			`forked child answered from inherited context ("${answer.slice(0, 160)}")`,
		);
	}

	// S9 — kill switch: honest typed refusal, hot-reloaded settings
	section("S9 kill-switch refusal");
	{
		writeSettings({ agents_kill_switch: true });
		const { answer } = await drive(
			"Use herdr_spawn_agent to spawn an agent named 'blocked-e2e' (kind 'pi', prompt 'hi'). Tell me exactly what happened, quoting the error you got.",
		);
		check(
			/kill ?switch|disabled|refus/i.test(answer),
			`honest refusal quoted ("${answer.slice(0, 160)}")`,
		);
	}
} finally {
	console.log("\n[cleanup]");
	await cleanupPanes();
	await cleanupPanes(); // second pass: closing can surface a parent shell
	writeSettings({});
	await sleep(1_000);
	rmSync(tmp, { recursive: true, force: true });
	console.log(`    temp project removed; panes under it closed`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
