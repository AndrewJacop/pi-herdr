// TEMP validation of the polling fallback in the EDITED src (loaded via jiti).
// 1) herdr_wait_agent(idle) on an ALREADY-idle pane -> must SUCCEED via poll fallback
//    (event `wait idle` fails on 0.7.3 when there's no transition to wait for).
// 2) herdr_delegate -> must still return the reply (no happy-path regression).
import { createJiti } from "jiti";
import { join } from "node:path";

const jiti = createJiti(import.meta.url);
const orch = await jiti.import(
	join(process.cwd(), "src/tools/orchestration.ts"),
	{ parent: process.cwd() },
);
const herdr = (
	await jiti.import(join(process.cwd(), "src/herdr.ts"), {
		parent: process.cwd(),
	})
).herdr;
const tools = [];
orch.registerOrchestration({
	registerTool: (d) => tools.push(d),
	on: () => {},
});
const waitAgent = tools.find((t) => t.name === "herdr_wait_agent");
const delegate = tools.find((t) => t.name === "herdr_delegate");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const close = async (t) => {
	await herdr(["pane", "close", t], { timeoutMs: 8000 }).catch(() => {});
};
const getStatus = async (t) => {
	const r = await herdr(["agent", "get", t], { timeoutMs: 8000 });
	const a = r.ok ? (r.data?.agent ?? r.data) : null;
	return a?.agent_status ?? "ERR";
};

const watchdog = setTimeout(() => {
	console.log("WATCHDOG");
	process.exit(2);
}, 180_000);
let pass = 0,
	fail = 0;
const check = (c, m) => {
	pass += c ? 1 : 0;
	fail += c ? 0 : 1;
	console.log((c ? "  ✓ " : "  ✗ ") + m);
};

try {
	console.log("[1] fallback: herdr_wait_agent(idle) on an already-idle pane");
	const s = await herdr(
		[
			"agent",
			"start",
			"fb-probe",
			"--cwd",
			process.cwd(),
			"--no-focus",
			"--",
			"pi",
		],
		{ timeoutMs: 20000 },
	);
	const pid = s.data?.agent?.pane_id;
	for (let i = 0; i < 40; i++) {
		if ((await getStatus(pid)) === "idle") break;
		await sleep(1000);
	}
	console.log(`   pane=${pid} boot status=${await getStatus(pid)}`);
	const t0 = Date.now();
	const w = await waitAgent.execute(
		"t",
		{ target: pid, status: "idle", timeoutMs: 15000 },
		undefined,
	);
	const ms = Date.now() - t0;
	check(
		!w.isError,
		`wait_agent(idle) on already-idle pane SUCCEEDED via fallback (isError=${w.isError}, ${ms}ms)`,
	);
	check(
		ms < 8000,
		`resolved fast via poll, not by waiting the 15s budget (${ms}ms)`,
	);
	await close(pid);

	console.log("\n[2] regression: herdr_delegate still completes");
	const d = await delegate.execute(
		"t",
		{
			prompt: "Reply with exactly one word: pong",
			cwd: process.cwd(),
			timeoutMs: 90000,
			closeOnSuccess: true,
		},
		undefined,
	);
	const txt = d.content?.[0]?.text ?? "";
	check(!d.isError, `delegate succeeded (isError=${d.isError})`);
	check(/pong/i.test(txt), `delegate response contains 'pong'`);
	console.log("   paneId:", d.details?.paneId);
} finally {
	clearTimeout(watchdog);
	console.log(
		`\n${fail === 0 ? "✅ ALL PASS" : "❌ SOME FAILED"} (${pass} passed, ${fail} failed)`,
	);
	process.exit(fail === 0 ? 0 : 1);
}
