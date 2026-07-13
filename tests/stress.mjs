// Stress test: 5 agents IN PARALLEL, each doing heavy multi-tool work — multiple
// bash commands with real output + several file read/write ops — so the spawned
// panes' TUI churns continuously with tool output (the condition that previously
// broke spinner-based state detection). Verifies the actual on-disk artifacts.
//
// What this stresses that tests/multi.mjs does not:
//   - more agents (5) running concurrently
//   - each agent runs MULTIPLE bash commands that emit output (the TUI never
//     sits on the "Working..." spinner for long)
//   - multi-file read/write + run + re-read, i.e. several turns of tool calls
//
// Requires a running herdr session + a working model/key for the spawned pis.
// Run: node tests/stress.mjs

import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { piArgv } from "./_platform.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url);

const orch = await jiti.import(join(ROOT, "src/tools/orchestration.ts"), {
	parent: ROOT,
});
const herdr = (await jiti.import(join(ROOT, "src/herdr.ts"), { parent: ROOT }))
	.herdr;

const tools = [];
orch.registerOrchestration({
	registerTool: (d) => tools.push(d),
	on: () => {},
});
const delegate = tools.find((t) => t.name === "herdr_delegate");

const EXT = join(ROOT, "src", "index.ts");
const ARGV = piArgv(["-e", EXT]);
const TIMEOUT = 360_000;

const tmp = mkdtempSync(join(tmpdir(), "pi-herdr-stress-"));
console.log("workdir:", tmp);

// Each task forces MULTIPLE tool calls incl. several bash commands w/ output.
const TASKS = [
	{
		name: "csv",
		cwd: join(tmp, "csv"),
		prompt:
			"Create `sales.csv` with header `product,amount` and exactly 5 data rows with amounts 100,200,300,400,500. " +
			"Create `total.js` that reads sales.csv, sums the amount column, and prints just the number. " +
			"Run `node total.js` AND run `node -e \"console.log(require('fs').readFileSync('sales.csv','utf8').trim().split('\\n').length)\"` " +
			"to confirm the row count. Report both outputs.",
		verify: (cwd) => {
			const files =
				existsSync(join(cwd, "sales.csv")) && existsSync(join(cwd, "total.js"));
			const out = run("node total.js", cwd);
			return { files, pass: out.trim() === "1500", out: out.trim() };
		},
	},
	{
		name: "filter",
		cwd: join(tmp, "filter"),
		prompt:
			"Create `words.txt` with these 10 words, one per line: apple banana fig grape kiwi lemon mango pear plum date. " +
			"Create `long.js` that reads words.txt, keeps only words LONGER than 4 characters, sorts them alphabetically, " +
			"writes them to `long.txt`, and prints them joined by single spaces. " +
			"Run `node long.js`, then `cat long.txt`, and report both.",
		verify: (cwd) => {
			const files =
				existsSync(join(cwd, "words.txt")) &&
				existsSync(join(cwd, "long.js")) &&
				existsSync(join(cwd, "long.txt"));
			const out = run("node long.js", cwd);
			return {
				files,
				pass: out.trim() === "apple banana grape lemon mango",
				out: out.trim(),
			};
		},
	},
	{
		name: "calc",
		cwd: join(tmp, "calc"),
		prompt:
			"Create `calc.js` exporting add, sub, mul, div. " +
			"Create `calc.test.js` that requires calc.js, asserts add(2,3)===5, sub(10,4)===6, mul(3,3)===9, div(20,5)===4, " +
			"and prints exactly PASS if all pass else FAIL. " +
			"Run `node calc.test.js` twice (once to test, once to confirm stable) and report the final stdout.",
		verify: (cwd) => {
			const files =
				existsSync(join(cwd, "calc.js")) &&
				existsSync(join(cwd, "calc.test.js"));
			const out = run("node calc.test.js", cwd);
			return { files, pass: /^PASS\b/m.test(out), out: out.trim() };
		},
	},
	{
		name: "json",
		cwd: join(tmp, "json"),
		prompt:
			"Create `users.json` with an array of 5 objects {name,age}: Alice 30, Bob 15, Carol 22, Dave 12, Eve 45. " +
			"Create `adults.js` that reads users.json, keeps age>=18, writes them to `adults.json`, and prints the count. " +
			"Run `node adults.js`, then run `node -e \"console.log(JSON.parse(require('fs').readFileSync('adults.json')).length)\"`, and report both.",
		verify: (cwd) => {
			const files =
				existsSync(join(cwd, "users.json")) &&
				existsSync(join(cwd, "adults.js")) &&
				existsSync(join(cwd, "adults.json"));
			const out = run("node adults.js", cwd);
			return { files, pass: out.trim() === "3", out: out.trim() };
		},
	},
	{
		name: "scan",
		cwd: join(tmp, "scan"),
		prompt:
			"Using your bash tool, create three files by running: " +
			"`printf 'line1\\nline2\\n' > a.txt`, `printf 'x\\ny\\nz\\n' > b.txt`, `printf 'hello\\n' > c.txt`. " +
			"Then create `count.js` that reads every .txt file in the current directory and prints the total number of lines. " +
			"Run `node count.js` and also `ls *.txt`, and report both.",
		verify: (cwd) => {
			const files = ["a.txt", "b.txt", "c.txt", "count.js"].every((f) =>
				existsSync(join(cwd, f)),
			);
			const out = run("node count.js", cwd);
			// Accept the bare total or a breakdown line like "Total: 6 lines".
			const pass = /Total:?\s*6\b/.test(out) || out.trim() === "6";
			return { files, pass, out: out.trim() };
		},
	},
];
for (const t of TASKS) mkdirSync(t.cwd, { recursive: true });

function run(cmd, cwd) {
	try {
		return execSync(cmd, { cwd, encoding: "utf8", timeout: 10_000 });
	} catch (e) {
		return (e.stdout || "") + (e.stderr || "");
	}
}

let pass = 0,
	fail = 0;
const check = (c, m) => {
	pass += c ? 1 : 0;
	fail += c ? 0 : 1;
	console.log((c ? "  ✓ " : "  ✗ ") + m);
};

console.log(
	`\nLaunching ${TASKS.length} agents in parallel (heavy multi-tool work)...`,
);
const t0 = Date.now();
const settledOrder = [];
const results = await Promise.all(
	TASKS.map((t) =>
		delegate
			.execute(
				"stress",
				{
					name: `stress-${t.name}`,
					agent: "custom",
					argv: ARGV,
					cwd: t.cwd,
					prompt: t.prompt,
					timeoutMs: TIMEOUT,
					closeOnSuccess: false,
				},
				undefined,
			)
			.then((r) => {
				const dur = ((Date.now() - t0) / 1000).toFixed(0);
				settledOrder.push(t.name);
				console.log(
					`  [${t.name}] delegate settled in ${dur}s (isError=${r.isError ?? false})`,
				);
				return { ...t, r };
			}),
	),
);

console.log(`\nsettle order: ${settledOrder.join(", ")}`);
console.log("\n=== Artifact verification ===");
for (const { name, cwd, r, verify } of results) {
	console.log(
		`\n[${name}] (pane ${r.details?.paneId ?? "?"}, isError=${r.isError === true})`,
	);
	check(r.isError !== true, `delegate completed cleanly`);
	const v = verify(cwd);
	check(v.files, `produced expected file(s)`);
	check(v.pass, `artifact output correct (got: ${v.out || "<empty>"})`);
}

console.log("\n=== Cleanup ===");
const agents = await herdr(["agent", "list"], { timeoutMs: 10_000 });
if (agents.ok) {
	for (const a of agents.data?.agents ?? []) {
		if (String(a.name ?? "").startsWith("stress-")) {
			const c = await herdr(["pane", "close", a.pane_id], {
				timeoutMs: 10_000,
			});
			check(c.ok, `closed ${a.name} (${a.pane_id})`);
		}
	}
}
try {
	rmSync(tmp, { recursive: true, force: true });
} catch {
	/* ignore */
}

const dur = ((Date.now() - t0) / 1000).toFixed(0);
console.log(
	`\n${fail === 0 ? "✅ ALL PASS" : "❌ SOME FAILED"} (${pass}/${pass + fail}) in ${dur}s`,
);
process.exit(fail === 0 ? 0 : 1);
