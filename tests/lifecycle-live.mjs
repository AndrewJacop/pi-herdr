// Live round-trips for the lifecycle actions (issue 10): real herdr + real
// spawned pi children.
//
//   Part 1 — interrupt → stop-and-redirect: a child mid-`sleep` is escaped
//   (turn cancel); the fleet row flips to `interrupted` IMMEDIATELY (while
//   herdr still reports working — the flag, not the poll); a following
//   herdr_message_agent redirects it and the child answers the new
//   instruction (back to active, then settled).
//
//   Part 2 — crash → gone → resume → push: a working child's pane is closed
//   (the crash, no sidecar); the registry record survives with the retained
//   session file; herdr_resume_agent relaunches it on the SAME session with
//   a re-derived launch plan and the opening message; the child answers a
//   question about its pre-crash work (proof the conversation replayed) and
//   the delivery loop pushes the resumed run's completion.
//
// Pane hygiene (house rule): every opened pane id is tracked and a `finally`
// closes them all. Concurrency (house rule): scenarios run strictly
// sequentially — never more than 2 child agents live beside the orchestrator
// (settings pin max_parallel_agents: 2); each part closes its child before
// the next starts.
//
// Hermetic-ish: runs in a temp project dir with pinned settings (a global
// kill-switch fails this honestly).
//
// Run: node tests/lifecycle-live.mjs   (after starting a `herdr` session;
//      needs ~6-8 min for two boots + a 90s sleep + the resume boot)

import { createJiti } from "jiti";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const tmp = mkdtempSync(join(tmpdir(), "pi-herdr-lifecycle-live-"));
mkdirSync(join(tmp, ".pi"), { recursive: true });
writeFileSync(
	join(tmp, ".pi", "herdr.json"),
	JSON.stringify({
		agents_kill_switch: false,
		max_parallel_agents: 2, // the concurrency pin: ≤2 children, ever
		max_spawn_depth: 3,
		default_kind: "pi",
		notifications: "normal",
		idle_rearm_minutes: 1,
	}),
);
process.chdir(tmp);

const jiti = createJiti(import.meta.url);
const agentsTool = await jiti.import(join(ROOT, "src/tools/agents.ts"), {
	parent: ROOT,
});
const lifecycleTool = await jiti.import(join(ROOT, "src/tools/lifecycle.ts"), {
	parent: ROOT,
});
const messageTool = await jiti.import(join(ROOT, "src/tools/message.ts"), {
	parent: ROOT,
});
const orchestration = await jiti.import(join(ROOT, "src/tools/orchestration.ts"), {
	parent: ROOT,
});
const delivery = await jiti.import(join(ROOT, "src/delivery.ts"), {
	parent: ROOT,
});
const { herdr } = await jiti.import(join(ROOT, "src/herdr.ts"), {
	parent: ROOT,
});

const tools = [];
const mockPi = { registerTool: (d) => tools.push(d), on: () => {} };
agentsTool.registerAgents(mockPi);
lifecycleTool.registerLifecycle(mockPi);
messageTool.registerMessageTool(mockPi);
const spawnTool = tools.find((t) => t.name === "herdr_spawn_agent");
const interruptTool = tools.find((t) => t.name === "herdr_interrupt_agent");
const resumeTool = tools.find((t) => t.name === "herdr_resume_agent");
const messageAgentTool = tools.find((t) => t.name === "herdr_message_agent");
for (const [n, t] of [
	["spawn", spawnTool],
	["interrupt", interruptTool],
	["resume", resumeTool],
	["message", messageAgentTool],
]) {
	if (!t) {
		console.error(`✗ ${n} tool not registered`);
		process.exit(1);
	}
}

let pass = 0,
	fail = 0;
const check = (c, m) => {
	pass += c ? 1 : 0;
	fail += c ? 0 : 1;
	console.log((c ? "  ✓ " : "  ✗ ") + m);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Live coarse agent_status of one pane (gone when the fleet lost it). */
async function fleetStatus(paneId) {
	const r = await herdr(["agent", "list"], { timeoutMs: 10_000 });
	if (!r.ok) return "list-failed";
	const agents = r.data?.result?.agents ?? r.data?.agents ?? [];
	const hit = agents.find((a) => a.pane_id === paneId);
	return hit ? (hit.agent_status ?? "live") : "gone";
}

/** Wait until the pane's coarse status hits one of `wanted`. */
async function awaitStatus(paneId, wanted, budgetMs) {
	const deadline = Date.now() + budgetMs;
	for (;;) {
		const st = await fleetStatus(paneId);
		if (wanted.includes(st)) return st;
		if (Date.now() >= deadline) return st;
		await sleep(2_000);
	}
}

/** The projected fleet row for a spawn handle (listAgentsView, real reads). */
async function projectedRow(name) {
	const r = await orchestration.listAgentsView({});
	if (!r.ok) return null;
	return r.data.rows.find((row) => row.name === name) ?? null;
}

async function awaitProjectedState(name, prefix, budgetMs) {
	const deadline = Date.now() + budgetMs;
	for (;;) {
		const row = await projectedRow(name);
		const state = row?.state ?? "(no row)";
		if (state === prefix || state.startsWith(prefix + " ") || state.startsWith(prefix + " ·"))
			return state;
		if (Date.now() >= deadline) return state;
		await sleep(2_000);
	}
}

/** Drive delivery passes until a push for `name` matches (or timeout). */
async function awaitPush(world, name, pred, budgetMs) {
	const deadline = Date.now() + budgetMs;
	while (Date.now() < deadline) {
		await delivery.deliverOnce(world.deps);
		const hit = world.pushes.find((m) => m.details?.name === name && pred(m));
		if (hit) return hit;
		await sleep(2_000);
	}
	return null;
}

const tracked = [];

/** Close every pane this run may have created: the tracked spawn panes plus
 * any pane whose cwd is inside this run's temp project. Scoped to `tmp` —
 * never touches a pane outside it. Best-effort: cleanup must not mask the
 * test result. */
async function cleanupPanes(paneIds) {
	for (const id of paneIds) {
		if (!id) continue;
		await herdr(["pane", "close", id], { timeoutMs: 10_000 }).catch(() => {});
	}
	const r = await herdr(["pane", "list"], { timeoutMs: 10_000 }).catch(() => null);
	const panes = r?.ok ? (r.data?.panes ?? r.data?.result?.panes ?? []) : [];
	for (const p of panes) {
		const id = p?.pane_id ?? p?.id;
		if (id && typeof p.cwd === "string" && p.cwd.startsWith(tmp)) {
			await herdr(["pane", "close", id], { timeoutMs: 10_000 }).catch(() => {});
		}
	}
}

/** Close a child and wait until it left the fleet (the sequential rule:
 * a part never starts while the previous part's child is still live). */
async function closeAndWaitGone(paneId) {
	if (!paneId) return;
	await herdr(["pane", "close", paneId], { timeoutMs: 10_000 }).catch(() => {});
	for (let i = 0; i < 20 && (await fleetStatus(paneId)) !== "gone"; i++)
		await sleep(2_000);
}

try {
	// -------------------------------------------------------------------
	console.log("\n[live 1] interrupt → stop-and-redirect");
	let part1Pane;
	{
		const name = `intlive-${Date.now()}`;
		// A generation-bound turn (no tools to refuse, no portability traps): a
		// few thousand emitted tokens keep the child working for minutes.
		const res = await spawnTool.execute(
			"live-interrupt",
			{
				name,
				agent: { name, interactive: true },
				prompt:
					"Without using any tools, write out the numbers from 1 to 3000, one per line, exactly, in your reply. Finish when done.",
			},
			undefined,
		);
		const d = res.details ?? {};
		part1Pane = d.paneId;
		if (d.paneId) tracked.push(d.paneId);
		check(res.isError !== true, `spawn ok (status: ${d.status}) ${res.isError ? res.content[0].text : ""}`);
		if (res.isError) throw new Error("part 1 spawn failed — see above");
		check(!!d.sessionPath, `session file seeded (${d.sessionPath})`);

		// the child must be genuinely mid-turn: wait for herdr to see working
		const st = await awaitStatus(d.paneId, ["working"], 90_000);
		check(st === "working", `child is working (status: ${st})`);
		await sleep(5_000); // comfortably inside the 90s sleep

		// the interrupt: Escape + the interruptedAt stamp
		const ir = await interruptTool.execute(
			"live-interrupt-2",
			{ target: name },
			undefined,
		);
		check(ir.isError !== true, `interrupt ok (${ir.isError ? ir.content[0].text : "escape sent"})`);
		check(
			ir.details?.interrupted === true && ir.details?.was === "working",
			`receipt {interrupted, was: working} (got ${JSON.stringify(ir.details?.was)})`,
		);

		// THE flip: immediate, while herdr still reports working — the flag
		// leads, the poll does not have to catch up first
		const coarse = await fleetStatus(d.paneId);
		const rowState = await projectedRow(name).then((r) => r?.state);
		check(
			rowState === "interrupted",
			`projected state is interrupted immediately (row: ${rowState}, herdr: ${coarse})`,
		);

		// stop-and-redirect: one message ends the interrupt and redirects
		const mr = await messageAgentTool.execute(
			"live-interrupt-3",
			{
				target: name,
				text:
					"Stop the sleep task. Reply with exactly this line and nothing else: REDIRECTED_OK",
			},
			undefined,
		);
		check(mr.isError !== true, `redirect message delivered (${mr.isError ? mr.content[0].text : "ok"})`);

		// new work → active again (fresh snapshot), then the turn settles.
		// Both settled outcomes are legitimate: `waiting` (pane open,
			// interactive stance) or `finalizing` (the child declared agent_done
				// — the tool stays available to interactive children too).
			const afterActive = await awaitProjectedState(name, "active", 120_000);
			check(
				afterActive.startsWith("active"),
				`the redirect returns it to active (${afterActive})`,
				);
			const settleDeadline = Date.now() + 180_000;
			let settledState = "(no row)";
			while (Date.now() < settleDeadline) {
				settledState = (await projectedRow(name))?.state ?? "(no row)";
				if (settledState === "waiting" || settledState === "finalizing") break;
				await sleep(2_000);
			}
			check(
				settledState === "waiting" || settledState === "finalizing",
				`the redirected turn settles (row: ${settledState})`,
			);
			// The CONVERSATION-level proof: the redirect turn (not the aborted
			// counting task) produced the answer. Search the whole file, not
			// just the last assistant message — an agent_done declaration can
			// append a trailing bookkeeping message after the answer.
			let sessionText = "";
			try {
				sessionText = readFileSync(d.sessionPath, "utf8");
			} catch {
				/* the check below reports it */
			}
			check(
				sessionText.includes("REDIRECTED_OK"),
				"the child answered the REDIRECTION (the turn rode the same session)",
			);

		await closeAndWaitGone(part1Pane);
	}

	// -------------------------------------------------------------------
	console.log("\n[live 2] crash → gone → resume → push");
	{
		const name = `reslive-${Date.now()}`;
		const pushes = [];
		const world = {
			pushes,
			deps: {
				push: (m) => pushes.push(m),
				now: () => Date.now(),
				list: async () => {
					const r = await herdr(["agent", "list"], { timeoutMs: 10_000 });
					if (!r.ok) return r;
					const agents = r.data?.result?.agents ?? r.data?.agents ?? [];
					return {
						ok: true,
						data: agents.map((a) => ({
							paneId: a.pane_id,
							name: a.name,
							agentStatus: a.agent_status,
						})),
					};
				},
			},
		};

		const res = await spawnTool.execute(
			"live-resume",
			{
				type: "general-purpose",
				name,
				prompt:
					'Use the bash tool to run exactly: echo PANDA > panda.txt — then reply with the single word DONE.',
			},
			undefined,
		);
		const d = res.details ?? {};
		if (d.paneId) tracked.push(d.paneId);
		check(res.isError !== true, `spawn ok (status: ${d.status}) ${res.isError ? res.content[0].text : ""}`);
		if (res.isError || !d.paneId || !d.sessionPath)
			throw new Error("part 2 spawn failed — see above");

		// wait until the child actually did the work, then crash it
		const marker = join(tmp, "panda.txt");
		let wrote = false;
		for (let i = 0; i < 90 && !wrote; i++) {
			wrote = existsSync(marker);
			if (!wrote) await sleep(2_000);
		}
		check(wrote, "the child wrote its marker before the crash");

		await herdr(["pane", "close", d.paneId], { timeoutMs: 10_000 });
		check(
			(await awaitStatus(d.paneId, ["gone"], 30_000)) === "gone",
			"the pane was closed mid-run (the crash)",
		);
		// the old run's terminal event resolves honestly (done-or-gone — a
		// pane-close death without a sidecar is the sentinel's call)
		await awaitPush(world, name, () => true, 60_000);
		const pushesBeforeResume = world.pushes.length;

		// THE recovery move: resume on the retained session, with a message
		const rr = await resumeTool.execute(
			"live-resume-2",
			{
				target: name,
				message:
					"What animal did you write into panda.txt before? Reply with exactly the animal name and nothing else.",
			},
			undefined,
			undefined,
			undefined,
		);
		check(rr.isError !== true, `resume ok (${rr.isError ? rr.content[0].text : "relaunched"})`);
		const rd = rr.details ?? {};
		if (rd.paneId) tracked.push(rd.paneId);
		check(
			rd.resumed === true && rd.paneId && rd.paneId !== d.paneId,
			`fresh pane, same handle (old ${d.paneId} → new ${rd.paneId})`,
		);
		check(
			rd.sessionPath === d.sessionPath,
			"the SAME retained session file (the registry held it)",
		);
		check(rd.stance === "autonomous", "stance follows the definition (autonomous)");

		// the resumed child boots on the replayed conversation, answers from
			// it, settles → sidecar → the push re-enters supervision. Only a
			// push from AFTER the resume counts (the crash may have resolved as
				// a done-sentinel first).
			let pushed = null;
			const pushDeadline = Date.now() + 300_000;
			while (Date.now() < pushDeadline && !pushed) {
				await delivery.deliverOnce(world.deps);
				pushed = world.pushes
					.slice(pushesBeforeResume)
					.find(
						(m) =>
							m.details?.name === name && m.details?.kind === "done",
					);
				if (!pushed) await sleep(2_000);
			}
		check(!!pushed, `the resumed run's completion was pushed (post-resume pushes: ${world.pushes.slice(pushesBeforeResume).map((m) => m.details?.kind).join(",") || "none"})`);
		check(
			!!pushed?.content.toUpperCase().includes("PANDA"),
			`the push answers from the REPLAYED conversation (PANDA) — got: ${pushed?.content.slice(0, 220).replace(/\s+/g, " ")}`,
			);
		check(
			!!pushed?.content.includes(rd.sessionPath ?? "«"),
			`the push carries the retained-session note — got: ${pushed?.content.slice(-120).replace(/\s+/g, " ")}`,
		);
		let after = rd.paneId ? await fleetStatus(rd.paneId) : "gone";
		for (let i = 0; i < 15 && after !== "gone"; i++) {
			await sleep(2_000);
			after = rd.paneId ? await fleetStatus(rd.paneId) : "gone";
		}
		check(after === "gone", `the resumed auto-exited child left the fleet (${after})`);
		check(
			existsSync(d.sessionPath ?? ""),
			"the session file is still retained (the recovery move stays available)",
		);
	}
} finally {
	await cleanupPanes(tracked);
	// Windows: a just-closed pane's cwd can hold the dir a moment longer —
	// retry, and never let cleanup mask the result.
	try {
		rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 1_000 });
	} catch {
		/* best-effort */
	}
}

console.log(`\n[done] ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
