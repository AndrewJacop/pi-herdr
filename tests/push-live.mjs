// Live push round-trip (issue 06): real herdr + real spawned pi children.
//
//   Part 1 — the push: an autonomous child completes, the delivery loop
//   detects the typed sidecar on the REAL disk and steers the child's EXACT
//   final message into the captured sink (the same call the orchestrator's
//   pi.sendMessage receives, flags included).
//
//   Part 2 — takeover + idle re-arm: a human "types" into a settled
//   interactive child's pane (raw `herdr pane run` — no steer watermark),
//   the takeover note lands quiet, and after `idle_rearm_minutes: 1` of
//   quiet the labeled auto-delivery arrives and the pane closes with its
//   session retained.
//
// Hermetic-ish: runs in a temp project dir with pinned settings (a global
// kill-switch fails this honestly).
//
// Run: node tests/push-live.mjs   (after starting a `herdr` session;
//      needs ~4-6 min for boot + two real child turns + the 60s re-arm)

import { createJiti } from "jiti";
import {
	existsSync,
	mkdtempSync,
	mkdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const tmp = mkdtempSync(join(tmpdir(), "pi-herdr-push-live-"));
mkdirSync(join(tmp, ".pi"), { recursive: true });
writeFileSync(
	join(tmp, ".pi", "herdr.json"),
	JSON.stringify({
		agents_kill_switch: false,
		max_parallel_agents: 3,
		max_spawn_depth: 2,
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
const delivery = await jiti.import(join(ROOT, "src/delivery.ts"), {
	parent: ROOT,
});
const { herdr } = await jiti.import(join(ROOT, "src/herdr.ts"), {
	parent: ROOT,
});

const tools = [];
const mockPi = { registerTool: (d) => tools.push(d), on: () => {} };
agentsTool.registerAgents(mockPi);
const spawnTool = tools.find((t) => t.name === "herdr_spawn_agent");
if (!spawnTool) {
	console.error("✗ spawn tool not registered");
	process.exit(1);
}

let pass = 0,
	fail = 0;
const check = (c, m) => {
	pass += c ? 1 : 0;
	fail += c ? 0 : 1;
	console.log((c ? "  ✓ " : "  ✗ ") + m);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Drive delivery passes until `pred` sees a matching push (or timeout). */
async function awaitPush(world, pred, budgetMs) {
	const deadline = Date.now() + budgetMs;
	while (Date.now() < deadline) {
		await delivery.deliverOnce(world.deps);
		const hit = world.pushes.find(pred);
		if (hit) return hit;
		await sleep(2_000);
	}
	return null;
}

async function fleetStatus(paneId) {
	const r = await herdr(["agent", "list"], { timeoutMs: 10_000 });
	if (!r.ok) return "list-failed";
	const agents = r.data?.result?.agents ?? r.data?.agents ?? [];
	const hit = agents.find((a) => a.pane_id === paneId);
	return hit ? (hit.agent_status ?? "live") : "gone";
}

const tracked = [];

/** Close every pane this run may have created: the tracked spawn panes plus
 * any pane whose cwd is inside this run's temp project (shells opened by the
 * raw typing, debris from a killed run). Scoped to `tmp` — never touches any
 * pane outside it. Best-effort: cleanup must not mask the test result. */
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

try {
	// -------------------------------------------------------------------
	console.log("\n[live 1] the push — autonomous child, sidecar route");
	{
		const pushes = [];
		const clock = { now: Date.now() };
		const world = {
			pushes,
			deps: {
				push: (m) => pushes.push(m),
				now: () => clock.now,
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

		const name = `pushlive-${Date.now()}`;
		const res = await spawnTool.execute(
			"live-push",
			{
				type: "general-purpose",
				name,
				prompt:
					"Reply with exactly this line and nothing else: PUSH_ROUNDTRIP_OK. Do not call any tools.",
				wait: 120_000,
			},
			undefined,
		);
		const d = res.details ?? {};
		if (d.paneId) tracked.push(d.paneId);
		check(res.isError !== true, `spawn ok (status: ${d.status})`);
		check(!!d.paneId, `paneId present: ${d.paneId}`);
		check(
			d.sessionPath && existsSync(d.sessionPath),
			`parent-owned session file seeded (${d.sessionPath})`,
		);

		// real env stamping proof lives in the child's behavior (part 2's 60s
		// re-arm); here we assert the spawn stamped its initial prompt as the
		// steer watermark, so the child's own task prompt is not a takeover.
		// The spawn's own prompt must not count as a takeover: by now the child
		// has consumed the steer watermark (that's the success path), so the
		// live signal is the ABSENCE of the takeover marker.
		const { existsSync: ex } = await import("node:fs");
		check(
			d.sessionPath && !ex(`${d.sessionPath}.takeover`),
			"the spawn's own prompt did not mark a takeover (steer watermark consumed)",
		);

		const pushed = await awaitPush(
			world,
			(m) => m.details?.name === name && m.details?.kind === "done",
			180_000,
		);
		check(!!pushed, "the delivery loop pushed the child's completion");
		check(
			pushed?.content.includes("PUSH_ROUNDTRIP_OK"),
			"the push carries the child's EXACT final message (the letter)",
		);
		check(
			pushed?.wake === true,
			"notifications normal → the push wakes (steer + triggerTurn flags)",
		);
		check(
			!pushed?.content.includes("auto-delivered after user steer"),
			"a plain completion is NOT mislabeled as auto-delivered",
		);
		// herdr's pane teardown lags the child's shutdown — poll for the exit
		let after = d.paneId ? await fleetStatus(d.paneId) : "gone";
		for (let i = 0; i < 15 && after !== "gone"; i++) {
			await sleep(2_000);
			after = d.paneId ? await fleetStatus(d.paneId) : "gone";
		}
		check(
			after === "gone",
			`the auto-exited child's pane left the fleet (${after})`,
		);
		check(
			d.sessionPath && existsSync(d.sessionPath),
			"the session file is retained after the pane closed",
		);
	}

	// -------------------------------------------------------------------
	console.log("\n[live 2] takeover + idle re-arm (idle_rearm_minutes: 1)");
	{
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

		const name = `rearmlive-${Date.now()}`;
		const res = await spawnTool.execute(
			"live-rearm",
			{
				name,
				agent: { name: "rearm-probe", auto_exit: false }, // interactive stance
				prompt:
					"Reply with exactly: REARM_READY then wait for further input. Do not call any tools.",
				wait: 150_000,
			},
			undefined,
		);
		const d = res.details ?? {};
		if (d.paneId) tracked.push(d.paneId);
		check(res.isError !== true, `interactive spawn ok (status: ${d.status})`);
		check(
			d.stance === "interactive",
			`interactive stance honored (${d.stance})`,
		);

		// wait for the first settle (the pane must be idle before "typing")
		let st = d.status;
		for (let i = 0; i < 90 && st !== "idle" && st !== "done"; i++) {
			await sleep(2_000);
			st = d.paneId ? await fleetStatus(d.paneId) : "gone";
		}
		check(st === "idle" || st === "done", `first settle observed (${st})`);

		// a HUMAN types into the pane — raw pane input, no steer watermark
		const typed = await herdr(
			[
				"pane",
				"run",
				d.paneId,
				'Reply with exactly: HELLO_FROM_HUMAN then stop. Do not call any tools."',
			],
			{ timeoutMs: 15_000, textOk: true },
		);
		check(typed.ok, "human keystrokes typed into the pane");

		// the takeover note lands quiet; the pane must NOT auto-close
		const note = await awaitPush(
			world,
			(m) => m.content === `user took over ${name}`,
			120_000,
		);
		check(!!note, "the quiet `user took over <agent>` note was pushed");
		check(note?.wake === false, "the takeover note does not wake (next natural turn)");
		const midSt = await fleetStatus(d.paneId);
		check(midSt !== "gone", `the pane never slammed shut on the human (${midSt})`);

		// idle re-arm: settle + 60s quiet → labeled delivery + pane close
		const labeled = await awaitPush(
			world,
			(m) =>
				m.details?.name === name &&
				m.content.includes("auto-delivered after user steer"),
			240_000,
		);
		check(
			!!labeled,
			"after takeover + settle + 1 quiet minute the result auto-delivered, labeled",
		);
		check(
			labeled?.content.includes("HELLO_FROM_HUMAN"),
			"the labeled delivery carries the post-steer final message",
		);
		// herdr's pane teardown lags the re-arm shutdown — poll for the exit
		let endSt = d.paneId ? await fleetStatus(d.paneId) : "gone";
		for (let i = 0; i < 15 && endSt !== "gone"; i++) {
			await sleep(2_000);
			endSt = d.paneId ? await fleetStatus(d.paneId) : "gone";
		}
		check(endSt === "gone", `the re-armed pane closed (${endSt})`);
		check(
			typeof d.sessionPath === "string" && existsSync(d.sessionPath),
			"the session is retained for resume",
		);
		check(
			labeled?.wake === true,
			"notifications normal → even the re-arm delivery wakes",
		);
	}
} catch (e) {
	fail++;
	console.error(`  ✗ threw: ${e instanceof Error ? e.stack : String(e)}`);
} finally {
	await cleanupPanes(tracked);
	try {
		rmSync(tmp, { recursive: true, force: true });
	} catch {
		/* best-effort */
	}
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
