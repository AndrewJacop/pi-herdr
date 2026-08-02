// Real orchestration test: spawn N agents IN PARALLEL, each doing multi-step,
// tool-using work (write file(s) + run them with node + report output), then
// verify the actual artifacts they produced on disk.
//
// This exercises: concurrent panes, the boot gate, multi-turn completion
// detection (self-report -> working/done) under real tool-call load (where the
// spinner is repeatedly replaced by tool output), and result harvesting.
//
// Requires a running herdr session + a working model/key for the spawned pis.
// Run: node tests/multi.mjs

import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url);

const orch = await jiti.import(join(ROOT, "src/tools/orchestration.ts"), {
	parent: ROOT,
});
const herdr = (await jiti.import(join(ROOT, "src/herdr.ts"), { parent: ROOT }))
	.herdr;

// Build the delegate tool the same way pi would.
const tools = [];
orch.registerOrchestration({
	registerTool: (d) => tools.push(d),
	on: () => {},
});
const delegate = tools.find((t) => t.name === "herdr_delegate");
if (!delegate) {
	console.error("herdr_delegate not registered");
	process.exit(1);
}

// Spawned pis load this extension so they self-report (reliable completion).
const EXT = join(ROOT, "src", "index.ts");
const AGENT_ARGS = ["-e", EXT]; // load this extension so spawned pis self-report
const TIMEOUT = 300_000; // 5 min per agent

const tmp = mkdtempSync(join(tmpdir(), "pi-herdr-multi-"));
console.log("workdir:", tmp);

const TASKS = [
	{
		name: "math",
		cwd: join(tmp, "math"),
		prompt:
			"Using your file tools, create two files in the current directory:\n" +
			"1. `math.js` with exactly: module.exports = { add: (a,b)=>a+b, mul: (a,b)=>a*b };\n" +
			"2. `test.js` that requires ./math.js, asserts add(2,3)===5 and mul(4,5)===20, " +
			"and prints exactly PASS if both pass, else FAIL.\n" +
			"Then run `node test.js` and report its exact stdout.",
		verify: (cwd) => {
			const js =
				existsSync(join(cwd, "math.js")) && existsSync(join(cwd, "test.js"));
			let out = "";
			try {
				out = execSync("node test.js", {
					cwd,
					encoding: "utf8",
					timeout: 10_000,
				});
			} catch (e) {
				out = (e.stdout || "") + (e.stderr || "");
			}
			return { js, pass: /^PASS\b/m.test(out), out: out.trim() };
		},
	},
	{
		name: "reverse",
		cwd: join(tmp, "reverse"),
		prompt:
			"Create `reverse.js` that reverses the string given as process.argv[2] and prints it. " +
			"Then run `node reverse.js hello` and report the exact stdout.",
		verify: (cwd) => {
			const js = existsSync(join(cwd, "reverse.js"));
			let out = "";
			try {
				out = execSync("node reverse.js hello", {
					cwd,
					encoding: "utf8",
					timeout: 10_000,
				});
			} catch (e) {
				out = (e.stdout || "") + (e.stderr || "");
			}
			return { js, pass: out.trim() === "olleh", out: out.trim() };
		},
	},
	{
		name: "fizzbuzz",
		cwd: join(tmp, "fizzbuzz"),
		prompt:
			"Create `fizzbuzz.js` that prints FizzBuzz for 1..15 (one per line; Fizz for /3, Buzz for /5, " +
			"FizzBuzz for /15). Run `node fizzbuzz.js` and report the first and last line of stdout.",
		verify: (cwd) => {
			const js = existsSync(join(cwd, "fizzbuzz.js"));
			let out = "";
			try {
				out = execSync("node fizzbuzz.js", {
					cwd,
					encoding: "utf8",
					timeout: 10_000,
				});
			} catch (e) {
				out = (e.stdout || "") + (e.stderr || "");
			}
			const lines = out.trim().split(/\r?\n/);
			return {
				js,
				pass:
					lines.length === 15 &&
					lines[2] === "Fizz" &&
					lines[14] === "FizzBuzz",
				out: lines.slice(0, 3).join("|") + " ... " + lines.slice(-2).join("|"),
			};
		},
	},
];
for (const t of TASKS) mkdirSync(t.cwd, { recursive: true });

let pass = 0,
	fail = 0;
const check = (c, m) => {
	pass += c ? 1 : 0;
	fail += c ? 0 : 1;
	console.log((c ? "  ✓ " : "  ✗ ") + m);
};

// ---- run all agents concurrently ------------------------------------------
console.log(`\nLaunching ${TASKS.length} agents in parallel...`);
const t0 = Date.now();
const results = await Promise.all(
	TASKS.map((t) =>
		delegate
			.execute(
				"multi",
				{
					name: `multi-${t.name}`,
					agent: "pi",
					agentArgs: AGENT_ARGS,
					cwd: t.cwd,
					prompt: t.prompt,
					timeoutMs: TIMEOUT,
					closeOnSuccess: false,
				},
				undefined,
			)
			.then((r) => {
				const dur = ((Date.now() - t0) / 1000).toFixed(0);
				console.log(
					`  [${t.name}] delegate settled in ${dur}s (isError=${r.isError ?? false})`,
				);
				return { ...t, r };
			}),
	),
);

// ---- verify artifacts ------------------------------------------------------
console.log("\n=== Results ===");
for (const { name, cwd, r, verify } of results) {
	console.log(`\n[${name}]`);
	const paneId = r.details?.paneId;
	const isError = r.isError === true;
	check(!isError, `delegate completed without error (pane ${paneId ?? "?"})`);
	const v = verify(cwd);
	check(v.js, `produced the expected file(s) in ${cwd}`);
	check(v.pass, `artifact runs correctly (output: ${v.out || "<empty>"})`);
}

// ---- cleanup ---------------------------------------------------------------
console.log("\n=== Cleanup ===");
const agents = await herdr(["agent", "list"], { timeoutMs: 10_000 });
if (agents.ok) {
	for (const a of agents.data?.agents ?? []) {
		if (String(a.name ?? "").startsWith("multi-")) {
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
