// Live workflow round-trip (issue 12): real herdr + real spawned pi children.
//
//   ONE live 3-agent pipeline fan-out, driven through the real
//   herdr_run_workflow tool: the tool returns immediately (run id + scratch
//   path + the no-poll instruction), three real panes spawn through the
//   ordinary gates, and the orchestrator receives exactly ONE aggregated
//   completion push carrying the pipeline's return value.
//
// Pane hygiene (house rule): every pane whose cwd is inside this run's temp
// project is tracked and closed in a `finally` — children that blocked,
// failed, or outlived the run included — and the test asserts a clean exit.
// Autonomous children normally auto-exit on settle; cleanup exists exactly
// for the paths where they don't. No manual pane closing is ever needed to
// get back to the original chat.
//
// Hermetic-ish: runs in a temp project dir with pinned settings (a global
// kill-switch fails this honestly).
//
// Run: node tests/workflow-live.mjs   (after starting a `herdr` session;
//      needs ~5-10 min for three real child boots + turns)

import { createJiti } from "jiti";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const tmp = mkdtempSync(join(tmpdir(), "pi-herdr-workflow-live-"));
mkdirSync(join(tmp, ".pi"), { recursive: true });
writeFileSync(
	join(tmp, ".pi", "herdr.json"),
	JSON.stringify({
		agents_kill_switch: false,
		max_parallel_agents: 3,
		max_spawn_depth: 2,
		default_kind: "pi",
		notifications: "normal",
	}),
);
process.chdir(tmp);

const jiti = createJiti(import.meta.url);
const wfTool = await jiti.import(join(ROOT, "src/tools/workflow.ts"), {
	parent: ROOT,
});
const runs = await jiti.import(join(ROOT, "src/workflow/runs.js"), {
	parent: ROOT,
});
const delivery = await jiti.import(join(ROOT, "src/delivery.ts"), {
	parent: ROOT,
});
const { herdr } = await jiti.import(join(ROOT, "src/herdr.ts"), {
	parent: ROOT,
});

const sent = [];
const defs = [];
const mockPi = {
	registerTool: (d) => defs.push(d),
	sendMessage: (msg, opts) => sent.push({ msg, opts }),
};
wfTool.registerWorkflowTool(mockPi);
const tool = defs[0];
if (!tool || tool.name !== "herdr_run_workflow") {
	console.error("✗ workflow tool not registered");
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

/** Close every pane whose cwd is inside this run's temp project — the spawned
 * children, their shells, any debris. Scoped to `tmp`: never touches a pane
 * outside it. Best-effort: cleanup must not mask the test result. */
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

/** Count panes still open whose cwd is inside tmp (0 after a clean exit). */
async function openTmpPanes() {
	const r = await herdr(["pane", "list"], { timeoutMs: 10_000 }).catch(() => null);
	const panes = r?.ok ? (r.data?.panes ?? r.data?.result?.panes ?? []) : [];
	return panes.filter(
		(p) => typeof p.cwd === "string" && p.cwd.startsWith(tmp),
	).length;
}

/** Drive delivery passes so per-child suppression is observable, and collect
 * nothing — the run's own push arrives through pi.sendMessage directly. */
async function deliveryTicks(budgetMs) {
	const deadline = Date.now() + budgetMs;
	while (Date.now() < deadline) {
		await delivery.deliverOnce().catch(() => {});
		const run = [...runs.workflowRuns().values()].at(-1);
		if (run && run.status !== "running") return run;
		await sleep(3_000);
	}
	return [...runs.workflowRuns().values()].at(-1);
}

try {
	console.log("\n[live] herdr_run_workflow — a 3-agent pipeline fan-out");
	{
		const workflow = `export const meta = {
  name: 'live-fanout',
  description: 'three real agents answer in parallel',
  phases: [{ title: 'Fanout' }],
}
phase('Fanout')
const outs = await pipeline(
  ['one', 'two', 'three'],
  (n) => agent('Reply with exactly one word and nothing else: ' + n, { label: 'say-' + n }),
)
log('collected ' + outs.filter(Boolean).length + ' of 3')
return outs`;

		const t0 = Date.now();
		const result = await tool.execute("live-1", { script: workflow }, undefined, undefined, undefined);
		check(result.isError !== true, `the tool accepted the run (${Math.round((Date.now() - t0) / 1000)}s to return)`);
		if (result.isError) {
			console.error("  tool error:", result.content?.[0]?.text);
		} else {
			check(
				/Run ID: wf_/.test(result.content[0].text) &&
					result.content[0].text.includes("started in the background") &&
					result.content[0].text.includes("do NOT poll or sleep"),
				"the tool returned immediately: run id + the no-poll instruction",
			);
			const runId = result.details.runId;
			check(result.details.scriptPath && result.details.scriptPath.endsWith(".workflow.js"), "the script path was reported (the edit-and-re-run loop)");

			// wait for the run to settle (delivery ticks keep the loop honest; the
			// run's own push arrives via pi.sendMessage regardless)
			const run = (await deliveryTicks(10 * 60_000)) ?? { status: "missing" };
			check(run.status === "completed", `the run completed (status: ${run.status}${run.result?.error ? ` — ${run.result.error}` : ""})`);

			// exactly ONE aggregated push, carrying the pipeline's value
			const pushes = sent.filter((s) => s.msg.details?.kind === "workflow");
			check(pushes.length === 1, `exactly ONE completion push (got ${pushes.length})`);
			const push = pushes[0]?.msg;
			check(
				push?.content.includes('Workflow "live-fanout" finished — 3/3 agents'),
				"the push reports 3/3 agents under the workflow name",
			);
			check(
				(push?.content ?? "").includes('["one","two","three"]'),
				"the push carries the pipeline's aggregated return value",
			);
			check(
				(push?.content ?? "").includes("collected 3 of 3"),
				"the script's log() line rides the report",
			);
			check(pushes[0]?.opts?.triggerTurn === true, "notifications normal: the completion wakes the orchestrator");
			check(typeof runId === "string" && runId.startsWith("wf_"), "the reported run id keys the run registry");
		}
	}
} finally {
	console.log("\n[pane hygiene] closing every pane this run opened");
	await cleanupPanes();
	await sleep(1_000);
	await cleanupPanes(); // second pass: closing a pane can surface its parent shell
	const leftover = await openTmpPanes();
	check(leftover === 0, `zero panes left open in the test's tmp project (got ${leftover})`);
	try {
		rmSync(tmp, { recursive: true, force: true });
	} catch {
		/* best-effort */
	}
}

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ SOME FAILED"} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
