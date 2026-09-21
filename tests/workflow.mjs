// Offline tests for the v0.6 workflow runtime (issue 12): the vm worker
// (determinism jail, codeGeneration off, caps, option validation, parallel/
// pipeline semantics, budget, boundary), the meta pre-parse contract, and the
// runtime core against a STUB WorkflowHost — the same seam split upstream
// uses, so none of this needs herdr, pi, or a live pane.
//
// Run: node tests/workflow.mjs

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
const jiti = createJiti(import.meta.url);

let passed = 0;
let failed = 0;
function assert(cond, msg) {
	if (cond) {
		passed++;
		console.log(`  ✓ ${msg}`);
	} else {
		failed++;
		console.error(`  ✗ ${msg}`);
	}
}
function eq(a, b) {
	return JSON.stringify(a) === JSON.stringify(b);
}

const rt = await jiti.import(join(ROOT, "src/workflow/runtime.ts"), {
	parent: ROOT,
});
const metaMod = await jiti.import(join(ROOT, "src/workflow/meta.ts"), {
	parent: ROOT,
});

// A hung test must fail loudly, not stall the suite forever (each test spawns
// a real worker thread; a stub that never releases would otherwise hang).
setTimeout(() => {
	console.error("\n❌ TIMEOUT — tests hung (a stub never settled?)");
	process.exit(2);
}, 120_000);

// A script that always satisfies the meta contract, with the given body.
const script = (body) =>
	`export const meta = { name: 't', description: 'test workflow' }\n${body}`;

/** Run one script to completion against a stub host. Never rejects. */
function runOnce(body, opts = {}) {
	return rt.runWorkflow({
		script: script(body),
		args: opts.args,
		// the HOST, not the wrapper — tests that need the recording seams make
		// their own stubHost() and pass its .host explicitly.
		host: opts.host ?? stubHost().host,
		signal: opts.signal,
		...(opts.agentCap !== undefined ? { agentCap: opts.agentCap } : {}),
		...(opts.itemCap !== undefined ? { itemCap: opts.itemCap } : {}),
		...(opts.nestedCap !== undefined ? { nestedCap: opts.nestedCap } : {}),
	});
}

/** A stub WorkflowHost: every agent resolves 'text-<n>'. Records requests. */
function stubHost(over = {}) {
	let n = 0;
	const requests = [];
	const aborted = [];
	const resumed = [];
	const gates = [];
	const host = {
		async spawnAgent(request) {
			requests.push(request);
			const i = ++n;
			if (over.spawnImpl) return over.spawnImpl(request, i);
			return { ok: true, text: `text-${i}` };
		},
		abortAgent(agentId) {
			aborted.push(agentId);
			over.abortImpl?.(agentId);
		},
		...(over.resumeImpl
			? {
					async resumeAgent(agentId, prompt) {
						resumed.push({ agentId, prompt });
						return over.resumeImpl(agentId, prompt);
					},
				}
			: {}),
		...(over.runGateImpl
			? {
					async runGate(command, opts) {
						gates.push({ command, opts });
						return over.runGateImpl(command, opts);
					},
				}
			: {}),
		...(over.loadWorkflowImpl ? { loadWorkflow: over.loadWorkflowImpl } : {}),
	};
	return { host, requests, aborted, resumed, gates };
}

/** Wait for a run that only ends when the test lets go of the host call. */
const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
console.log("\n[1] meta pre-parse — pure-literal contract");

{
	const { meta, body } = metaMod.extractMeta(
		"export const meta = { name: 'audit', description: 'd', phases: [{ title: 'Scan', detail: 'a}b' }] }\nreturn 1;",
	);
	assert(
		eq(meta, {
			name: "audit",
			description: "d",
			phases: [{ title: "Scan", detail: "a}b" }],
		}),
		"extractMeta reads name/description/phases (brace inside detail survives the scan)",
	);
	assert(
		body.startsWith("       const meta") && !body.includes("export"),
		"body strips only `export` (6 spaces keep offsets)",
	);
	assert(
		eq(metaMod.extractMeta("export const meta = {name:'a',description:'b'}\n").body.slice(0, 6), "      "),
		"export keyword replaced by spaces, byte length unchanged",
	);

	const impure = [
		["variable", "const n='x';\nexport const meta = { name: n, description: 'd' }"],
		["call", "export const meta = { name: upper('a'), description: 'd' }"],
		["spread", "const b={};\nexport const meta = { name: 'a', description: 'd', ...b }"],
	];
	for (const [what, src] of impure) {
		let threw = "";
		try {
			metaMod.extractMeta(src);
		} catch (e) {
			threw = e.message;
		}
		assert(
			threw.includes("PURE LITERAL"),
			`impure meta (${what}) is rejected with the pure-literal hint`,
		);
	}
	let threw = "";
	try {
		metaMod.extractMeta("export const meta = { name: `a${1}b`, description: 'd' }");
	} catch (e) {
		threw = e.message;
	}
	assert(
		threw.includes("template interpolation"),
		"self-evaluating template interpolation rejected explicitly",
	);
	threw = "";
	try {
		metaMod.extractMeta("const meta = { name: 'a' }");
	} catch (e) {
		threw = e.message;
	}
	assert(
		threw.includes("must begin with `export const meta"),
		"missing export declaration is the first rejection",
	);
	threw = "";
	try {
		metaMod.extractMeta("export const meta = { description: 'd' }");
	} catch (e) {
		threw = e.message;
	}
	assert(threw.includes("meta.name` is required"), "missing name rejected");
	threw = "";
	try {
		metaMod.extractMeta("export const meta = { name: 'a', description: 'd', phases: 'x' }");
	} catch (e) {
		threw = e.message;
	}
	assert(threw.includes("meta.phases` must be an array"), "non-array phases rejected");

	assert(
		metaMod.hasMetaDeclaration("x=1;\nexport  const\nmeta = { name: 'a', description: 'b' }"),
		"hasMetaDeclaration tolerates inner whitespace (issue 13's marker)",
	);
	assert(
		!metaMod.hasMetaDeclaration("const meta = { name: 'a' }"),
		"hasMetaDeclaration: no export, no claim",
	);
}

// ---------------------------------------------------------------------------
console.log("\n[2] validateScript — size and character rules");

{
	let threw = "";
	try {
		rt.validateScript("x".repeat(rt.MAX_SCRIPT_LENGTH + 1));
	} catch (e) {
		threw = e.message;
	}
	assert(
		threw.includes(`over the limit of ${rt.MAX_SCRIPT_LENGTH}`),
		"script over 512 KiB rejected with the limit named",
	);
	threw = "";
	try {
		rt.validateScript(script("return 1;\n\u0000"));
	} catch (e) {
		threw = e.message;
	}
	assert(
		threw.includes("control characters"),
		"control characters rejected (tab/CRLF allowed)",
	);
}

// ---------------------------------------------------------------------------
console.log("\n[3] happy path — agent + parallel + log + phases");

{
	const s = stubHost();
	const result = await runOnce(
		`phase('Scan')
const one = await agent('discover', { label: 'discover', agentType: 'Explore' })
log('found ' + one)
phase('Audit')
const outs = await parallel([
  () => agent('a1', { label: 'a1' }),
  () => agent('a2', { label: 'a2' }),
])
return outs.filter(Boolean).length`,
		{ host: s.host },
	);
	assert(result.status === "completed", "run completes");
	assert(result.value === 2, "parallel results flow into the return value");
	assert(result.agentCount === 3, "agentCount counts all three agents");
	assert(
		s.requests.every((r) => r.agentType === "Explore" || r.agentType === "general-purpose"),
		"unspecified agentType defaults to general-purpose",
	);
	const phases = result.progress.filter((e) => e.type === "workflow_phase");
	assert(
		eq(phases.map((p) => p.title), ["Scan", "Audit"]),
		"phase() defines ordered progress groups",
	);
	const logs = result.progress.filter((e) => e.type === "workflow_log");
	assert(
		logs.some((l) => l.message === "found text-1"),
		"log() lines land in the progress log",
	);
	const rows = result.progress.filter((e) => e.type === "workflow_agent");
	assert(
		rows.filter((r) => r.state === "done").length === 3 &&
			rows.every((r) => r.label && r.agentId),
		"per-agent rows appear as start→done",
	);
	assert(eq(result.meta, { name: "t", description: "test workflow" }), "run result carries the meta");
}

// ---------------------------------------------------------------------------
console.log("\n[4] determinism jail + code generation");

{
	const result = await runOnce("return String(Date.now());");
	assert(
		result.status === "failed" &&
			result.error.includes("Date.now() is unavailable in workflow scripts (breaks resume)"),
		"Date.now() throws with the resume ruling",
	);
	const d = await runOnce("return String(new Date());");
	assert(
		d.status === "failed" && d.error.includes("new Date() is unavailable"),
		"zero-arg new Date() throws",
	);
	const dated = await runOnce("return new Date(0).getTime() === 0;");
	assert(dated.value === true, "new Date(ms) is allowed (arg'd constructor fine)");
	const r = await runOnce("return String(Math.random());");
	assert(
		r.status === "failed" && r.error.includes("Math.random() is unavailable"),
		"Math.random() throws",
	);
	const ev = await runOnce("return eval('1+1');");
	assert(
		ev.status === "failed" &&
			/codeneration|code generation|EvalError/i.test(ev.error),
		"eval() is blocked in the vm (codeGeneration.strings off)",
	);
}

// ---------------------------------------------------------------------------
console.log("\n[5] caps");

{
	const s = stubHost();
	const result = await runOnce(
		"await agent('1'); await agent('2'); await agent('3');",
		{ host: s.host, agentCap: 2 },
	);
	assert(
		result.status === "failed" &&
			result.error.includes("Workflow exceeded its cap of 2 agents."),
		"agent cap is fatal, naming the cap",
	);
	assert(s.requests.length === 2, "no agent past the cap is spawned");

	const items = await runOnce(
		`const big = new Array(4097).fill(0).map((_, i) => i)
return await parallel(big.map((i) => () => i))`,
	);
	assert(
		items.status === "failed" &&
			items.error.includes("was given 4097 items, over the limit of 4096"),
		"parallel item cap enforced per call",
	);
	const pipe = await runOnce(
		"return await pipeline(new Array(4097).fill(0), (v) => v)",
	);
	assert(
		pipe.status === "failed" && pipe.error.includes("over the limit of 4096"),
		"pipeline item cap enforced per call",
	);
}

// ---------------------------------------------------------------------------
console.log("\n[6] un-awaited agent() ruling");

{
	const s = stubHost({
		// The launch stays open past the script's return — that is the window the
		// ruling exists for. An instantly-resolving stub would win the race.
		spawnImpl: async () => {
			await new Promise((r) => setTimeout(r, 250));
			return { ok: true, text: "late" };
		},
	});
	const result = await runOnce("agent('fire and forget'); return 'done';", {
		host: s.host,
	});
	assert(
		result.status === "failed" &&
			result.error ===
				"workflow script completed with unawaited agent launch(es): 'fire and forget'. Await or return each launch.",
		"un-awaited agent() fails the run with the verbatim ruling",
	);
	assert(s.aborted.length > 0, "the un-awaited child is aborted on the way out");
}

// ---------------------------------------------------------------------------
console.log("\n[7] JSON boundary");

{
	let threw = "";
	try {
		await rt.runWorkflow({ script: script("return 1"), host: stubHost().host, args: (() => {
			const o = {};
			o.self = o;
			return o;
		})() });
	} catch (e) {
		threw = e.message;
	}
	assert(
		threw.includes("circular structure"),
		"non-JSON args rejected before the worker (circular)",
	);
	threw = "";
	try {
		await rt.runWorkflow({ script: script("return 1"), host: stubHost().host, args: { at: new Map() } });
	} catch (e) {
		threw = e.message;
	}
	assert(threw.includes("non-plain object"), "Map args rejected before the worker");

	const circ = await runOnce("const o = {}; o.self = o; return o;");
	assert(
		circ.status === "failed" && circ.error.includes("circular structure"),
		"circular return value fails the run",
	);
	const sparse = await runOnce("const a = [1, , 3]; return a;");
	assert(
		sparse.status === "failed" && sparse.error.includes("sparse array"),
		"sparse return array fails the run",
	);
	const map = await runOnce("return new Map([['a', 1]]);");
	assert(
		map.status === "failed" && map.error.includes("non-plain object"),
		"Map return value fails the run",
	);
	const withArgs = await runOnce("return args.root ?? 'none';", { args: { root: "src/" } });
	assert(withArgs.value === "src/", "args cross into the script realm verbatim");
	const noArgs = await runOnce("return args === undefined;");
	assert(noArgs.value === true, "no args → args is undefined");
}

// ---------------------------------------------------------------------------
console.log("\n[8] option validation");

{
	const bad = await runOnce("return await agent('p', { wibble: 1 })");
	assert(
		bad.status === "failed" && bad.error.includes("opts.wibble is not a recognised option"),
		"unknown option key rejected by name",
	);
	const schema = await runOnce("return await agent('p', { schema: { type: 'object' } })");
	assert(
		schema.status === "failed" &&
			schema.error.includes("opts.schema is not supported here") &&
			schema.error.includes("issue 14"),
		"schema is a NAMED refusal (issue 14's stretch), not a silent drop",
	);
	const effort = await runOnce("return await agent('p', { effort: 'extreme' })");
	assert(
		effort.status === "failed" && effort.error.includes("must be one of"),
		"effort validated against pi's thinking levels",
	);
	const off = stubHost();
	const offRun = await runOnce("return await agent('p', { effort: 'off' })", { host: off.host });
	assert(
		offRun.status === "completed" && off.requests[0].effort === "off",
		"effort 'off' accepted (pi level)",
	);
	const iso = await runOnce("return await agent('p', { isolation: 'docker' })");
	assert(
		iso.status === "failed" && iso.error.includes('must be "worktree"'),
		"isolation must be exactly worktree",
	);
	const both = await runOnce(
		"await agent('first', { label: 'fix' }); return await agent('x', { resume: 'fix', model: 'p/m' })",
	);
	assert(
		both.status === "failed" && both.error.includes("mutually exclusive"),
		"resume + model rejected: a resumed child keeps its spawn contract",
	);
	const promptObj = await runOnce("return await agent({ nope: 1 })");
	assert(
		promptObj.status === "failed" && promptObj.error.includes("agent(prompt) requires a non-empty string"),
		"non-string prompt rejected",
	);
}

// ---------------------------------------------------------------------------
console.log("\n[9] parallel / pipeline semantics");

{
	const s = stubHost();
	const result = await runOnce(
		"return await parallel([() => 1, () => { throw new Error('x') }, () => 3])",
		{ host: s.host },
	);
	assert(eq(result.value, [1, null, 3]), "a throwing thunk → null, siblings unaffected");

	const pipe = await runOnce(
		`return await pipeline(
  ['a', 'b'],
  (v, item, idx) => v + item + idx,
  (v, item) => { if (v.startsWith('a')) throw new Error('boom'); return v + '!' }
)`,
	);
	assert(
		eq(pipe.value, [null, "bb1!"]),
		"pipeline stages see (prev, item, index); a throwing stage drops only its item",
	);
	const fatal = await runOnce(
		"return await parallel([() => agent('p'), () => agent('q')])",
		{ agentCap: 1 },
	);
	assert(
		fatal.status === "failed" && fatal.error.includes("exceeded its cap of 1 agents"),
		"fatal (workflow) errors propagate through parallel instead of becoming null",
	);
	const swallowed = await runOnce(
		"return await parallel([() => agent('p'), () => agent('q', { wibble: 1 })])",
	);
	assert(
		eq(swallowed.value, ["text-1", null]),
		"worker-side option errors are ordinary script errors — parallel folds them to null",
	);
	// barrier-free: stage 2 of item 1 runs before item 2's stage 1 resolves.
	const order = [];
	let releaseSecond;
	const gate = new Promise((r) => (releaseSecond = r));
	const slow = stubHost({
		spawnImpl: async (request) => {
			order.push(`start:${request.prompt}`);
			if (request.prompt === "slow") await gate;
			order.push(`end:${request.prompt}`);
			return { ok: true, text: request.prompt };
		},
	});
	const pipedP = runOnce(
		"return await pipeline(['slow', 'fast'], (p) => agent(p), (t) => t + '!')",
		{ host: slow.host },
	);
	// Let both items start and the fast one walk its whole chain while the slow
	// one is parked on the gate — then let go and collect the run.
	await tick(80);
	releaseSecond();
	const piped = await pipedP;
	assert(piped.status === "completed", "no-barrier pipeline completes");
	assert(
		eq(order, ["start:slow", "start:fast", "end:fast", "end:slow"]),
		"no barrier: the fast item walks its whole chain while the slow one runs",
	);
}

// ---------------------------------------------------------------------------
console.log("\n[10] budget + globals");

{
	const b = await runOnce(
		"return [budget.total, budget.spent() === Infinity, budget.remaining() === Infinity]",
	);
	assert(eq(b.value, [null, true, true]), "budget: total null, spent/remaining honestly Infinity");
	const meta = await runOnce("return [typeof meta, meta.name]");
	assert(eq(meta.value, ["object", "t"]), "meta is a realm object the script can read");
}

// ---------------------------------------------------------------------------
console.log("\n[11] gate mapping");

{
	const ok = stubHost({ runGateImpl: async () => ({ ok: true, output: "" }) });
	const pass = await runOnce("return await agent('p', { gate: 'npm test' })", { host: ok.host });
	assert(
		pass.value === "text-1" && ok.gates.length === 1 && ok.gates[0].command === "npm test",
		"a passing gate leaves the result intact",
	);
	const fail = stubHost({ runGateImpl: async () => ({ ok: false, output: "3 tests failed" }) });
	const rejected = await runOnce("return await agent('p', { gate: 'npm test' })", {
		host: fail.host,
	});
	assert(
		rejected.value === null,
		"a failing gate turns the agent into null (typed failure, not a crash)",
	);
	const row = rejected.progress
		.filter((e) => e.type === "workflow_agent")
		.at(-1);
	assert(
		row.state === "error" && row.error === "3 tests failed",
		"the gate output becomes the row's error",
	);
	assert(
		fail.requests[0].gate === "npm test",
		"the gate command rides the spawn request",
	);
}

// ---------------------------------------------------------------------------
console.log("\n[12] resume mapping");

{
	const s = stubHost({
		resumeImpl: async (agentId, prompt) => ({ ok: true, text: `resumed:${agentId}:${prompt}` }),
	});
	const result = await runOnce(
		"await agent('first', { label: 'fix' }); return await agent('continue', { resume: 'fix' })",
		{ host: s.host },
	);
	assert(result.status === "completed", "resume run completes");
	assert(
		eq(s.resumed, [{ agentId: "wf-agent-0", prompt: "continue" }]),
		"resume revives the labelled child's agent id with the new prompt",
	);
	assert(result.value === "resumed:wf-agent-0:continue", "the resumed text is the call's value");
	const unknown = await runOnce("return await agent('x', { resume: 'nope' })", {
		host: stubHost({ resumeImpl: async () => ({ ok: true, text: "never" }) }).host,
	});
	assert(
		unknown.status === "failed" &&
			unknown.error.includes('no agent has completed under the label "nope"'),
		"an unknown resume label is fatal with known labels guidance",
	);
}

// ---------------------------------------------------------------------------
console.log("\n[13] capabilities the host lacks");

{
	const wf = await runOnce("return await workflow('saved-one')");
	assert(
		wf.status === "failed" &&
			wf.error.includes("cannot run nested workflows") &&
			wf.error.includes("issue 13"),
		"workflow() refuses fatally until issue 13 lands resolution",
	);
	const g = await runOnce("return await agent('p', { gate: 'x' })");
	// stub host in runOnce has no runGate → fatal
	assert(
		g.status === "failed" && g.error.includes("cannot run gate commands"),
		"gate without host.runGate is fatal BEFORE spawning (never an un-run gate)",
	);
	const r = await runOnce(
		"await agent('first', { label: 'fix' }); return await agent('again', { resume: 'fix' })",
	);
	assert(
		r.status === "failed" && r.error.includes("cannot resume agents"),
		"resume without host.resumeAgent is fatal",
	);
}

// ---------------------------------------------------------------------------
console.log("\n[14] abort");

{
	const ac = new AbortController();
	const hang = stubHost({
		spawnImpl: async () => {
			await new Promise(() => {}); // never settles — the run must abort it
			return { ok: true, text: "never" };
		},
	});
	const runP = runOnce("return await agent('long');", { host: hang.host, signal: ac.signal });
	await tick(50);
	ac.abort();
	const result = await runP;
	assert(result.status === "killed" && result.error === "Workflow aborted.", "abort → killed");
	assert(hang.aborted.length === 1, "the in-flight child is aborted host-side");
}

// ---------------------------------------------------------------------------
console.log("\n[15] option mapping onto the spawn request");

{
	const s = stubHost();
	await runOnce(
		`await agent('map me', {
  label: 'audit:src/a.ts',
  agentType: 'Explore',
  model: 'prov/model-1',
  effort: 'high',
  isolation: 'worktree',
})`,
		{ host: s.host },
	);
	const r = s.requests[0];
	assert(r.label === "audit:src/a.ts", "label rides the request");
	assert(r.agentType === "Explore", "agentType rides the request");
	assert(r.model === "prov/model-1", "model rides the request (exact id, enforced host-side)");
	assert(r.effort === "high", "effort rides the request (host maps → --thinking)");
	assert(r.isolation === "worktree", "isolation rides the request (host maps → isolated)");

	const unlabeled = stubHost();
	await runOnce("await agent('first line of the prompt\\nsecond line')", { host: unlabeled.host });
	assert(
		unlabeled.requests[0].label === "first line of the prompt",
		"a missing label derives from the prompt's first line",
	);
}

// ---------------------------------------------------------------------------
console.log("\n[16] nested workflow() loader seam (host that HAS loadWorkflow)");

{
	const s = stubHost({
		loadWorkflowImpl: () => ({
			ok: true,
			script: "export const meta = { name: 'child', description: 'c' }\nreturn await agent('from-child')",
		}),
	});
	const result = await runOnce("return await workflow('child')", { host: s.host });
	assert(result.status === "completed", "a host-side loader resolves nested workflows");
	assert(result.value === "text-1", "the child's agents are this run's agents");
	const bad = stubHost({
		loadWorkflowImpl: () => ({ ok: false, message: 'No saved workflow named "x".' }),
	});
	const missing = await runOnce("try { await workflow('x') } catch (e) { return 'caught' }", {
		host: bad.host,
	});
	assert(
		missing.value === "caught",
		"resolution failures are the script's to catch (non-fatal)",
	);
}

// ---------------------------------------------------------------------------
console.log("\n[17] host seam — option mapping, completion, gate, abort, resume");

{
	const hostMod = await jiti.import(join(ROOT, "src/workflow/host.ts"), {
		parent: ROOT,
	});

	/** Fake engine world: injectable seams, captured calls. */
	function engineWorld(over = {}) {
		const spawnCalls = [];
		const resumeCalls = [];
		const resultCalls = [];
		const closed = [];
		const gateCalls = [];
		const registry = new Map();
		let seq = 0;
		/** The completion script: what each getAgentResult call returns, in order. */
		const results = over.results ?? [];
		const deps = {
			pi: {},
			spawn: async (params, d) => {
				spawnCalls.push({ params, deps: d });
				if (over.spawnImpl) return over.spawnImpl(params, d);
				const name = `agent-${++seq}`;
				registry.set(name, {
					name,
					kind: "pi",
					prompt: "",
					agentArgs: [],
					depth: 2,
					isolated: false,
					spawnedAt: 0,
					submitted: true,
					sawWorking: true,
					stance: "autonomous",
					paneId: `w1:${name}`,
				});
				return {
					ok: true,
					data: { name, status: "working", kind: "pi", depth: 2, stance: "autonomous" },
				};
			},
			result: async (params, _d) => {
				resultCalls.push(params);
				const next = results.shift();
				if (next === undefined) {
					return {
						ok: true,
						data: { target: params.target, source: "registry", status: "done", result: "final text" },
					};
				}
				return { ok: true, data: { target: params.target, source: "registry", ...next } };
			},
			resume: async (params, d) => {
				resumeCalls.push({ params, deps: d });
				if (over.resumeImpl) return over.resumeImpl(params, d);
				return {
					ok: true,
					data: { name: params.target, status: "working", kind: "pi", depth: 2, stance: "autonomous", resumed: true },
				};
			},
			closePane: async (paneId) => {
				closed.push(paneId);
				return { ok: true };
			},
			exec: async (command, cwd) => {
				gateCalls.push({ command, cwd });
				return over.gate ?? { ok: true, output: "" };
			},
			records: () => registry,
		};
		return { deps, spawnCalls, resumeCalls, resultCalls, closed, gateCalls, registry };
	}

	const WF = (over) => hostMod.createWorkflowHost({ pi: {}, runId: "wf_test0001", ...over });

	// option mapping: one call carries the whole table
	{
		const w = engineWorld();
		const host = WF({
			...w.deps,
			ctx: {
				model: { provider: "zai", id: "glm-5" },
				modelRegistry: { find: () => undefined, hasConfiguredAuth: () => false },
			},
		});
		const out = await host.spawnAgent({
			agentId: "wf-agent-0",
			index: 0,
			prompt: "do the thing",
			label: "audit:a.ts",
			agentType: "Explore",
			model: "zai/glm-5",
			effort: "high",
			isolation: "worktree",
		});
		assert(out.ok === true && out.text === "final text", "a mapped spawn resolves to the child's final text");
		const call = w.spawnCalls[0];
		assert(
			call.params.type === "Explore" &&
				call.params.kind === "pi" &&
				call.params.model === "zai/glm-5" &&
				call.params.thinking === "high" &&
				call.params.isolated === true &&
				call.params.name === "audit:a.ts" &&
				call.params.wait === false,
			"option table maps: type/kind-pi/model/thinking/isolated/name/background",
		);
		assert(
			w.registry.get("agent-1")?.workflow === "wf_test0001",
			"the child record is stamped with the run id (delivery skips per-child pushes)",
		);
		assert(call.deps.parent && call.deps.registry, "engine deps carry the parent routing + registry");
		assert(w.resultCalls[0].wait === true, "completion awaited through getAgentResult (the 06 detection)");
	}

	// defaults: unset options stay unset
	{
		const w = engineWorld();
		const host = WF(w.deps);
		await host.spawnAgent({ agentId: "wf-agent-0", index: 0, prompt: "p", label: "x", agentType: "general-purpose" });
		const call = w.spawnCalls[0];
		assert(call.params.type === "general-purpose", "agentType rides through as the type");
		assert(
			call.params.model === undefined && call.params.thinking === undefined && call.params.isolated !== true,
			"unset options stay unset (routing falls through the chain)",
		);
	}

	// spawn refusal → per-agent failure (the script sees null, the run continues)
	{
		const w = engineWorld({
			spawnImpl: async () => ({
				ok: false,
				error: { code: "VALIDATION_ERROR", message: 'model "bad" from routing level 1 (spawn param): no such model' },
			}),
		});
		const host = WF(w.deps);
		const out = await host.spawnAgent({ agentId: "wf-agent-0", index: 0, prompt: "p", label: "x", agentType: "general-purpose", model: "bad" });
		assert(
			out.ok === false && out.error.includes("routing level 1"),
			"a bad model is THIS agent's failure and the error names the routing level",
		);
	}

	// non-pi agentType → per-agent refusal (decided: pi-only children)
	{
		const dir = mkdtempSync(join(tmpdir(), "pi-herdr-wfhost-"));
		const agentsDir = join(dir, ".pi", "agents");
		mkdirSync(agentsDir, { recursive: true });
		writeFileSync(
			join(agentsDir, "cc-runner.md"),
			'---\nname: cc-runner\ndescription: a claude agent\nkind: claude\n---\n\nYou run on claude.\n',
		);
		const w = engineWorld();
		const host = WF({ ...w.deps, agentDirs: { project: agentsDir, global: join(dir, "global-agents") } });
		const out = await host.spawnAgent({ agentId: "wf-agent-0", index: 0, prompt: "p", label: "x", agentType: "cc-runner" });
		assert(
			out.ok === false && out.error.includes("pi-only") && out.error.includes("cc-runner"),
			"a non-pi agentType is a NAMED per-agent refusal (never silently coerced)",
		);
		assert(w.spawnCalls.length === 0, "the refusal lands before the spawn engine is called");
		// a pi-kind (and an unset-kind) definition passes the check
		writeFileSync(
			join(agentsDir, "pi-runner.md"),
			'---\nname: pi-runner\ndescription: a pi agent\nkind: pi\n---\n\nYou run on pi.\n',
		);
		const ok = await host.spawnAgent({ agentId: "wf-agent-1", index: 1, prompt: "p", label: "y", agentType: "pi-runner" });
		assert(ok.ok === true && w.spawnCalls.length === 1, "a pi-kind definition spawns normally");
		rmSync(dir, { recursive: true, force: true });
	}

	// completion mapping: typed error, gone, blocked→wait→done
	{
		const w = engineWorld({ results: [{ status: "error", error: { stopReason: "error", errorMessage: "provider overloaded" } }] });
		const host = WF(w.deps);
		const out = await host.spawnAgent({ agentId: "wf-agent-0", index: 0, prompt: "p", label: "x", agentType: "general-purpose" });
		assert(
			out.ok === false && out.error === "error: provider overloaded",
			"a typed child failure carries stopReason + message",
		);
	}
	{
		const w = engineWorld({ results: [{ status: "gone", note: "pane died; session retained" }] });
		const host = WF(w.deps);
		const out = await host.spawnAgent({ agentId: "wf-agent-0", index: 0, prompt: "p", label: "x", agentType: "general-purpose" });
		assert(
			out.ok === false && out.error.includes("gone without completing") && out.error.includes("pane died"),
			"gone resolves to a typed failure naming the retained session",
		);
	}
	{
		const w = engineWorld({ results: [
			{ status: "blocked" },
			{ status: "done", result: "answered then done" },
		] });
		const host = WF(w.deps);
		const out = await host.spawnAgent({ agentId: "wf-agent-0", index: 0, prompt: "p", label: "x", agentType: "general-purpose" });
		assert(
			out.ok === true && out.text === "answered then done" && w.resultCalls.length === 2,
			"blocked keeps waiting; the settled re-poll delivers",
		);
	}

	// gate: runs against the child's worktree, failure carries the output
	{
		const w = engineWorld();
		const host = WF({ ...w.deps });
		await host.spawnAgent({ agentId: "wf-agent-0", index: 0, prompt: "p", label: "x", agentType: "general-purpose" });
		w.registry.set("agent-1", { ...w.registry.get("agent-1"), worktreePath: "D:/wt/one" });
		await host.runGate("pass", { agentId: "wf-agent-0" });
		assert(
			w.gateCalls[0].cwd === "D:/wt/one",
			"a gate runs in the child's worktree (verifies the tree the child wrote)",
		);
	}

	// abort: pane close for started children, never-start mark for queued ones
	{
		const w = engineWorld();
		const host = WF(w.deps);
		await host.spawnAgent({ agentId: "wf-agent-0", index: 0, prompt: "p", label: "x", agentType: "general-purpose" });
		host.abortAgent("wf-agent-0");
		await new Promise((r) => setTimeout(r, 10));
		assert(w.closed.length === 1 && w.closed[0] === "w1:agent-1", "abort closes the child's pane (session retained)");
		host.abortAgent("wf-agent-9");
		assert(w.closed.length === 1, "abort of an unknown agent id is a no-op");
		// queued record: no pane — the drain must never start it after the run
		w.registry.get("agent-1").paneId = undefined;
		host.abortAgent("wf-agent-0");
		assert(
			w.registry.get("agent-1").startError?.includes("ended before this child started"),
			"abort of a queued child marks it never-started (the drain won't resurrect it)",
		);
	}

	// resume: handle translation + the 10 machinery + completion
	{
		const w = engineWorld({ results: [
			{ status: "done", result: "spawn text" },
			{ status: "done", result: "resumed final" },
		] });
		const host = WF(w.deps);
		const first = await host.spawnAgent({ agentId: "wf-agent-0", index: 0, prompt: "p", label: "fix", agentType: "general-purpose" });
		assert(first.text === "spawn text", "the spawn consumes its own completion read");
		const out = await host.resumeAgent("wf-agent-0", "continue");
		assert(out.ok === true && out.text === "resumed final", "resume returns the continued child's final text");
		assert(
			w.resumeCalls[0].params.target === "agent-1" && w.resumeCalls[0].params.message === "continue",
			"resume translates the runtime agent id to the registry handle + new prompt",
		);
		const missing = await host.resumeAgent("wf-agent-77", "?");
		assert(missing.ok === false && missing.error.includes("never started"), "resuming an unknown id refuses");
	}

	// the host through the REAL runtime: an end-to-end offline run
	{
		const w = engineWorld();
		const host = hostMod.createWorkflowHost({ pi: {}, runId: "wf_e2e00001", ...w.deps });
		const result = await rt.runWorkflow({
			script: script(
				"phase('P1')\nconst outs = await parallel([() => agent('a', { label: 'a' }), () => agent('b', { label: 'b' })])\nlog('done')\nreturn outs",
			),
			host,
		});
		assert(
			result.status === "completed" && eq(result.value, ["final text", "final text"]),
			"host-through-runtime: a 2-agent parallel run completes",
		);
		assert(
			w.spawnCalls.length === 2 && [...w.registry.values()].every((r) => r.workflow === "wf_e2e00001"),
			"both children spawned and run-stamped",
		);
	}
}

// ---------------------------------------------------------------------------
console.log("\n[18] runs.ts + the tool — background lifecycle, gate, scratch file");

{
	const runsMod = await jiti.import(join(ROOT, "src/workflow/runs.ts"), { parent: ROOT });
	// The TOOL's internal chain resolves runs via the `.js` specifier, which jiti
	// caches as a SEPARATE instance from the `.ts` path above (the known dual-
		// instance hazard the spawn engine's header documents). Registry assertions
	// on tool-driven runs must read the tool's own instance.
	const runsViaJs = await jiti.import(join(ROOT, "src/workflow/runs.js"), { parent: ROOT });
	const wfTool = await jiti.import(join(ROOT, "src/tools/workflow.ts"), { parent: ROOT });

	const GOOD = script("return await agent('a', { label: 'one' })");
	/** A stub host whose single agent completes. */
	const stubHost = () => ({
		async spawnAgent() {
			return { ok: true, text: "child text" };
		},
		abortAgent() {},
	});
	/** Mock pi capturing registerTool defs + sendMessage calls. */
	function mockPi() {
		const tools = [];
		const sent = [];
		return {
			pi: {
				registerTool: (def) => tools.push(def),
				sendMessage: (msg, opts) => sent.push({ msg, opts }),
			},
			tools,
			sent,
		};
	}
	const settings = (workflows_enabled = true, notifications = "normal") => ({
		workflows_enabled,
		notifications,
	});

	// --- startWorkflowRun: scratch file, run id, completion push -------------
	{
		const pushes = [];
		const started = runsMod.startWorkflowRun({
			script: GOOD,
			host: stubHost(),
			pi: { sendMessage: () => {} },
			push: (m) => pushes.push(m),
			load: () => settings("normal"),
		});
		assert(/^wf_[a-z0-9]{12}$/.test(started.run.runId), `run id shape wf_<hex> (${started.run.runId})`);
		assert(
			started.run.scriptPath.startsWith(runsMod.workflowScratchDir()) &&
				started.run.scriptPath.endsWith(".workflow.js"),
			"the script lands in the scratch dir as <runid>.workflow.js (the edit-and-re-run loop)",
		);
		assert(
			existsSync(started.run.scriptPath) &&
				readFileSync(started.run.scriptPath, "utf8") === GOOD,
			"the scratch file carries the verbatim source",
		);
		assert(started.run.status === "running", "the run starts as running");
		const result = await started.done;
		assert(result.status === "completed" && started.run.status === "completed", "the run settles completed");
		assert(
			pushes.length === 1 &&
				pushes[0].content.includes('Workflow "t" finished — 1/1 agents') &&
				pushes[0].content.includes("child text") &&
				pushes[0].wake === true,
			"completion pushes ONE aggregated report (counts + return value), wake per notifications",
		);
		assert(
			pushes[0].content.includes(started.run.scriptPath),
			"the completion report carries the script path (the edit-and-re-run loop)",
			);
		// quiet: completed runs deliver on the next natural turn
		const quiet = runsMod.startWorkflowRun({
			script: GOOD,
			host: stubHost(),
			pi: { sendMessage: () => {} },
			push: (m) => pushes.push(m),
			load: () => settings(true, "quiet"),
		});
		await quiet.done;
		assert(
			pushes.at(-1).wake === false,
			"notifications quiet: a completed run delivers without waking",
		);
		// failure always wakes
		const bad = runsMod.startWorkflowRun({
			script: script("return Date.now()"),
			host: stubHost(),
			pi: { sendMessage: () => {} },
			push: (m) => pushes.push(m),
			load: () => settings(true, "quiet"),
		});
		await bad.done;
		assert(
			pushes.at(-1).wake === true && pushes.at(-1).content.includes('FAILED'),
			"a failed run always wakes, naming the error",
		);
	}

	// --- the tool: gate, validation, immediate return ------------------------
	{
		const { pi, tools, sent } = mockPi();
		wfTool.registerWorkflowTool(pi, { load: () => settings(true), host: stubHost() });
		const tool = tools[0];
		assert(tool.name === "herdr_run_workflow", "the tool registers as herdr_run_workflow");

		// gate at REGISTRATION: workflows_enabled false → the tool is ABSENT
		// from the surface (the ticket checkbox)
		const gatedPi = mockPi();
		wfTool.registerWorkflowTool(gatedPi.pi, { load: () => settings(false) });
		assert(
			gatedPi.tools.length === 0,
			"workflows_enabled: false removes the tool from the surface (no registration)",
		);

		// gate at EXECUTE (mid-session toggle): registered while true, refused after
		const toggle = { ...settings(true) };
		const togglePi = mockPi();
		wfTool.registerWorkflowTool(togglePi.pi, { load: () => toggle, host: stubHost() });
		const refused = await togglePi.tools[0].execute("t1", { script: GOOD }, undefined, undefined, undefined);
		assert(refused.isError !== true, "registered while enabled → the run starts");
		toggle.workflows_enabled = false;
		const afterToggle = await togglePi.tools[0].execute("t1b", { script: GOOD }, undefined, undefined, undefined);
		assert(
			afterToggle.isError === true && afterToggle.details.error.code === "SPAWN_REFUSED",
			"toggled off mid-session → execute refuses new runs (hot-reload; registration re-evaluates on /reload)",
		);

		// missing source
		const noSrc = await tool.execute("t2", {}, undefined, undefined, undefined);
		assert(noSrc.isError && noSrc.details.error.message.includes("scriptPath"), "no script/scriptPath → clean refusal");

		// bad meta
		const badMeta = await tool.execute("t3", { script: "const meta = {}" }, undefined, undefined, undefined);
		assert(badMeta.isError && badMeta.details.error.message.includes("PURE LITERAL"), "invalid meta refuses with author-facing guidance");

		// non-JSON args
		const circular = {};
		circular.self = circular;
		const badArgs = await tool.execute("t4", { script: GOOD, args: circular }, undefined, undefined, undefined);
		assert(badArgs.isError && badArgs.details.error.message.includes("circular"), "non-JSON args refuse before anything runs");

		// scriptPath precedence: the file wins over the inline script
		const dir = mkdtempSync(join(tmpdir(), "pi-herdr-wftool-"));
		const file = join(dir, "saved.js");
		writeFileSync(file, GOOD);
		const okRun = await tool.execute("t5", { script: "export const meta = { name: 'wrong', description: 'x' }", scriptPath: file, args: { a: 1 } }, undefined, undefined, undefined);
		assert(
			okRun.isError !== true && okRun.details.name === "t",
			"scriptPath wins over script; the returned name comes from the file's meta",
		);
		assert(
			/Run ID: wf_/.test(okRun.content[0].text) &&
				okRun.content[0].text.includes("started in the background") &&
				okRun.content[0].text.includes("do NOT poll or sleep"),
			"the tool returns immediately: run id + script path + the no-poll instruction",
		);
		// the background run settles and steers through pi.sendMessage
		await new Promise((r) => setTimeout(r, 50));
		assert(
			sent.length === 1 && sent[0].msg.content.includes('Workflow "t" finished'),
			"the run's completion lands as one steered message",
		);
		const delivery = sent[0].msg;
		assert(
			delivery.customType === "herdr-delivery" && sent[0].opts.triggerTurn === true,
			"delivery-style steer: customType + wake (notifications normal)",
		);
		const record = runsViaJs.workflowRuns().get(okRun.details.runId);
		assert(record?.status === "completed", "the run registry tracks the settled run");
		rmSync(dir, { recursive: true, force: true });
	}

	// --- unreadable scriptPath ------------------------------------------------
	{
		const { pi, tools } = mockPi();
		wfTool.registerWorkflowTool(pi, { load: () => settings(true) });
		const missing = await tools[0].execute("t6", { scriptPath: "D:/nope/missing.js" }, undefined, undefined, undefined);
		assert(missing.isError && missing.details.error.message.includes("could not read scriptPath"), "an unreadable scriptPath refuses cleanly");
	}
}

// ---------------------------------------------------------------------------
console.log(
	`\n${failed === 0 ? "✅ ALL PASS" : "❌ SOME FAILED"} (${passed} passed, ${failed} failed)`,
);
process.exit(failed === 0 ? 0 : 1);
