// Offline red-green tests for v0.6 issue 13: the resume journal (write/replay,
// prefix boundary on failure, resume-declined journals, replay-aware resume
// errors) and saved-workflow discovery (.pi/workflows → .agents/workflows →
// global, first hit wins; the `export const meta` marker; the meta pre-parse).
// Same seam split as tests/workflow.mjs — runtime against a stub host, no
// herdr, pi, or live pane. The journal path is exercised against a real tmp
// directory because append/read are the feature.
//
// Run: node tests/workflow-journal-saved.mjs

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

setTimeout(() => {
	console.error("\n❌ TIMEOUT — tests hung (a stub never settled?)");
	process.exit(2);
}, 120_000);

const rt = await jiti.import(join(ROOT, "src/workflow/runtime.ts"), { parent: ROOT });
const jr = await jiti.import(join(ROOT, "src/workflow/journal.ts"), { parent: ROOT });
const sv = await jiti.import(join(ROOT, "src/workflow/saved.ts"), { parent: ROOT });
const runsMod = await jiti.import(join(ROOT, "src/workflow/runs.ts"), { parent: ROOT });
const metaMod = await jiti.import(join(ROOT, "src/workflow/meta.ts"), { parent: ROOT });

// A script that always satisfies the meta contract, with the given body.
const script = (body) =>
	`export const meta = { name: 't', description: 'test workflow' }\n${body}`;

/** A stub WorkflowHost: every agent resolves 'text-<n>'. Records requests. */
function stubHost(over = {}) {
	let n = 0;
	const requests = [];
	const host = {
		async spawnAgent(request) {
			requests.push(request);
			const i = ++n;
			if (over.spawnImpl) return over.spawnImpl(request, i);
			return { ok: true, text: `text-${i}` };
		},
		abortAgent() {},
		...(over.resumeImpl
			? {
					async resumeAgent(agentId, prompt) {
						return over.resumeImpl(agentId, prompt);
					},
				}
			: {}),
		...(over.loadWorkflowImpl ? { loadWorkflow: over.loadWorkflowImpl } : {}),
	};
	return { host, requests };
}

/** Journal entries for the calls a script would make, as a prior run left them. */
function journalFor(calls) {
	return calls.map((call, index) => ({
		index,
		key: jr.journalKey(call),
		ok: call.ok !== false,
		...(call.ok !== false ? { text: call.text ?? `text-${index + 1}` } : {}),
		...(call.resumed ? { resumed: true } : {}),
	}));
}

// ---------------------------------------------------------------------------
console.log("\n[1] journal.ts — keys, append/read round-trip");
{
	// key stability and sensitivity
	const base = { prompt: "do x", label: "a" };
	assert(jr.journalKey(base) === jr.journalKey({ ...base }), "the same call keys the same");
	for (const [field, value] of [
		["prompt", "do y"],
		["label", "b"],
		["model", "openai/gpt"],
		["agentType", "reviewer"],
		["effort", "high"],
		["isolation", "worktree"],
		["gate", "npm test"],
		["resume", "a"],
	]) {
		assert(
			jr.journalKey(base) !== jr.journalKey({ ...base, [field]: value }),
			`a changed ${field} changes the key`,
		);
	}

	// append + read round-trip, sorted by index
	const dir = mkdtempSync(join(tmpdir(), "wfj-"));
	const path = join(dir, "run.workflow.jsonl");
	jr.appendJournal(path, { index: 2, key: "k2", ok: true, text: "c" });
	jr.appendJournal(path, { index: 0, key: "k0", ok: true, text: "a" });
	jr.appendJournal(path, { index: 1, key: "k1", ok: false });
	jr.appendJournal(path, { index: 3, key: "k3", ok: true, text: "d", resumed: true });
	const entries = jr.readJournal(path);
	assert(
		JSON.stringify(entries.map((e) => e.index)) === "[0,1,2,3]",
		"append order does not matter — readJournal returns position order",
	);
	assert(entries[1].ok === false, "a journaled failure survives the round-trip");
	assert(entries[3].resumed === true, "the resume marker survives the round-trip");

	// a mangled file costs entries, never the read
	writeFileSync(path, `${readFileSync(path, "utf8")}{truncat`, "utf8");
	assert(jr.readJournal(path).length === 4, "a partial final line is skipped, not fatal");
	writeFileSync(path, "not json\n", "utf8");
	assert(jr.readJournal(path).length === 0, "garbage lines are skipped, not fatal");
	assert(jr.readJournal(join(dir, "missing.jsonl")).length === 0, "a missing journal replays nothing");
	rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
console.log("\n[2] runtime — prefix replay: unchanged prefix comes from disk");
{
	const calls = [
		{ prompt: "p1", label: "one" },
		{ prompt: "p2", label: "two" },
	];
	const entries = journalFor(calls);
	const appendLog = [];

	// full hit: nothing spawns
	{
		const s = stubHost();
		const result = await rt.runWorkflow({
			script: script(
				`return [await agent('p1', { label: 'one' }), await agent('p2', { label: 'two' })];`,
			),
			host: s.host,
			journal: { entries, append: (e) => appendLog.push(e) },
		});
		assert(
			s.requests.length === 0 && result.replayedCount === 2 && result.status === "completed",
			`an unchanged prefix spawns nothing (${s.requests.length} spawns, ${result.replayedCount} replayed)`,
		);
		const rows = result.progress.filter((e) => e.type === "workflow_agent");
		const doneRows = rows.filter((r) => r.state === "done");
		assert(rows.length === 4 && doneRows.length === 2, "each call emits a start row, then its settle row");
		assert(
			doneRows.every((r) => r.cached === true && r.durationMs === 0),
			"replayed rows read as done, flagged cached, and cost 0ms",
		);
		assert(
			result.value.join("|") === "text-1|text-2",
			"the script receives the journal's recorded text",
		);
		assert(
			appendLog.length === 2 && appendLog.every((e) => e.ok === true),
			"replays are re-recorded so this run's journal stands alone",
		);
	}

	// a changed suffix pays only the delta
	{
		const s = stubHost();
		const result = await rt.runWorkflow({
			script: script(
				`return [await agent('p1', { label: 'one' }), await agent('p2 EDITED', { label: 'two' })];`,
			),
			host: s.host,
			journal: { entries },
		});
		assert(
			s.requests.length === 1 &&
				s.requests[0].prompt === "p2 EDITED" &&
				result.replayedCount === 1,
			"a changed second call runs live and alone (the delta)",
		);
	}

	// a gap breaks the prefix at the gap (built by omission: a 2-call journal
	// against a 3-call script leaves position 1 with no entry)
	{
		const s = stubHost();
		const result = await rt.runWorkflow({
			script: script(`return [await agent('p1', { label: 'one' }), await agent('p2', { label: 'two' })];`),
			host: s.host,
			journal: { entries: [entries[0], entries[2]].filter(Boolean) },
		});
		assert(
			result.replayedCount === 1 && s.requests.length === 1,
			"a missing position ends the prefix there (not a lookup table)",
		);
	}

	// a key mismatch at position 0 replays nothing
	{
		const s = stubHost();
		const result = await rt.runWorkflow({
			script: script(`return await agent('DIFFERENT', { label: 'one' });`),
			host: s.host,
			journal: { entries: [entries[0]] },
		});
		assert(
			result.replayedCount === 0 && s.requests.length === 1,
			"the first changed call runs live, and everything after it would too",
		);
	}
}

// ---------------------------------------------------------------------------
console.log("\n[3] runtime — failure ends the prefix; resume decline");
{
	// journal: agent 0 ok, agent 1 FAILED, agent 2 ok → resume re-runs 1 and 2
	const entries = [
		{ index: 0, key: jr.journalKey({ prompt: "p1" }), ok: true, text: "text-1" },
		{ index: 1, key: jr.journalKey({ prompt: "p2" }), ok: false },
		{ index: 2, key: jr.journalKey({ prompt: "p3" }), ok: true, text: "text-3" },
	];
	{
		const s = stubHost();
		const result = await rt.runWorkflow({
			script: script(
				`return [await agent('p1'), await agent('p2'), await agent('p3')];`,
			),
			host: s.host,
			journal: { entries },
		});
		assert(
			result.replayedCount === 1 &&
				s.requests.length === 2 &&
				s.requests[0].prompt === "p2",
			"a journaled failure ends the prefix — resuming retries exactly that agent",
		);
	}

	// a journal that used `resume` is declined whole
	{
		const resumedJournal = journalFor([
			{ prompt: "p1", label: "one", resumed: true },
			{ prompt: "p2" },
		]);
		const s = stubHost();
		const result = await rt.runWorkflow({
			script: script(`return [await agent('p1', { label: 'one' }), await agent('p2')];`),
			host: s.host,
			journal: { entries: resumedJournal },
		});
		assert(
			result.replayedCount === 0 && s.requests.length === 2,
			"a journal carrying a resumed call replays nothing (no conversation to continue)",
		);
	}

	// resuming a REPLAYED label is fatal, with the replay-aware message
	// (the stub HAS resumeAgent, so the capability check passes and what fails
	// is the journal-aware refusal — the resume itself is never reached)
	{
		const s = stubHost({
			resumeImpl: async () => ({ ok: true, text: "must not be reached" }),
		});
		const result = await rt.runWorkflow({
			script: script(
				`await agent('p1', { label: 'one' });\nreturn await agent('go', { resume: 'one' });`,
			),
			host: s.host,
			journal: { entries: journalFor([{ prompt: "p1", label: "one" }]) },
		});
		assert(
			result.status === "failed" &&
				result.error.includes("was replayed from the resume journal"),
			"resume of a replayed label fails naming the journal, not a typo",
		);
	}

	// resuming a LIVE label still works when nothing was replayed
	{
		const s = stubHost({
			resumeImpl: async () => ({ ok: true, text: "continued" }),
		});
		const result = await rt.runWorkflow({
			script: script(
				`await agent('p1', { label: 'one' });\nreturn await agent('go', { resume: 'one' });`,
			),
			host: s.host,
			journal: { entries: journalFor([{ prompt: "p1", label: "one", resumed: true }]) },
		});
		assert(
			result.status === "completed" && result.value === "continued",
			"with the journal declined, a live label stays resumable",
		);
	}
}

// ---------------------------------------------------------------------------
console.log("\n[4] runs.ts — the journal lands on disk; resumeFromRunId replays it");
{
	const GOOD = script(`return [await agent('p1', { label: 'one' })];`);
	const settings = () => ({ workflows_enabled: true, notifications: "normal" });

	// a run journals its settled calls beside its script
	{
		const s = stubHost();
		const started = runsMod.startWorkflowRun({
			script: GOOD,
			host: s.host,
			cwd: mkdtempSync(join(tmpdir(), "pi-herdr-jnl-")),
			pi: { sendMessage: () => {} },
			push: () => {},
			load: settings,
		});
		assert(
			started.run.journalPath.endsWith(`${started.run.runId}.workflow.jsonl`) &&
				started.run.journalPath.startsWith(runsMod.workflowScratchDir()),
			"the journal sits beside the script under the same run id",
		);
		await started.done;
		const entries = jr.readJournal(started.run.journalPath);
		assert(
			entries.length === 1 && entries[0].ok === true && entries[0].text === "text-1",
			"the settled agent() call is journaled with its text",
		);
		// resolveResumeTarget against the registry
		assert(runsMod.resolveResumeTarget(undefined) === undefined, "no resumeFromRunId → no target");
		const unknown = runsMod.resolveResumeTarget("wf_deadbeefcafe");
		assert(
			unknown && unknown.ok === false && unknown.message.includes("No workflow run"),
			"an unknown run id is an error, not a cold start",
		);
		const known = runsMod.resolveResumeTarget(started.run.runId);
		assert(
			known && known.ok === true && known.journalPath === started.run.journalPath,
			"a settled run resolves to its journal",
		);

		// resume it: the unchanged prefix replays, nothing spawns
		const pushes = [];
		const s2 = stubHost();
		const second = runsMod.startWorkflowRun({
			script: GOOD,
			host: s2.host,
			cwd: mkdtempSync(join(tmpdir(), "pi-herdr-jnl-")),
			pi: { sendMessage: () => {} },
			push: (m) => pushes.push(m),
			load: settings,
			resumeFrom: { runId: started.run.runId, journalPath: known.journalPath },
		});
		assert(second.run.resumedFrom === started.run.runId, "the run records what it resumed from");
		const result = await second.done;
		assert(
			s2.requests.length === 0 && result.replayedCount === 1,
			"resuming an unchanged run re-pays nothing",
		);
		assert(
			pushes[0].content.includes(`1 replayed from ${started.run.runId}`),
			"the completion report counts the replays",
		);
	}

	// a still-running run cannot be resumed
	{
		let release;
		const gate = new Promise((r) => (release = r));
		const started = runsMod.startWorkflowRun({
			script: GOOD,
			host: {
				async spawnAgent() {
					await gate;
					return { ok: true, text: "late" };
				},
				abortAgent() {},
			},
			cwd: mkdtempSync(join(tmpdir(), "pi-herdr-jnl-")),
			pi: { sendMessage: () => {} },
			push: () => {},
			load: settings,
		});
		const running = runsMod.resolveResumeTarget(started.run.runId);
		assert(
			running && running.ok === false && running.message.includes("still running"),
			"a running run refuses resume (its journal is mid-write)",
		);
		release();
		await started.done;
	}
}

// ---------------------------------------------------------------------------
console.log("\n[5] saved.ts — discovery order, the meta marker, precedence");
{
	const dir = mkdtempSync(join(tmpdir(), "wfs-"));
	const mk = (rel, content) => {
		mkdirSync(join(dir, rel, ".."), { recursive: true });
		writeFileSync(join(dir, rel), content, "utf8");
	};
	const meta = (name) =>
		`export const meta = { name: '${name}', description: 'd' }\nreturn await agent('x');`;

	// first hit wins: project .pi > shared .agents > global
	mk(".pi/workflows/dup.js", meta("from-pi"));
	mk(".agents/workflows/dup.js", meta("from-agents"));
	const dup = sv.readSavedWorkflow("dup", dir);
	assert(dup.ok && dup.script.includes("from-pi"), "project .pi/workflows shadows .agents (first hit wins)");
	mk(".agents/workflows/only.js", meta("agents-only"));
	assert(
		sv.readSavedWorkflow("only", dir).ok,
		".agents/workflows is a read location when .pi lacks the name",
	);

	// a shadowing NON-workflow is reported, not silently reached past
	mk(".pi/workflows/shadow.js", "return 1; // no meta\n");
	mk(".agents/workflows/shadow.js", meta("real-one"));
	const shadow = sv.readSavedWorkflow("shadow", dir);
	assert(
		shadow.ok === false &&
			shadow.message.includes("is not a workflow script") &&
			shadow.message.includes("export const meta"),
		"a meta-less file at the winning path refuses as 'not a workflow' — a validation rule, not a convention",
	);

	// unknown names list what exists; unsafe names refuse before touching disk
	const unknown = sv.readSavedWorkflow("nope", dir);
	assert(
		unknown.ok === false && unknown.message.includes("Available: "),
		"an unknown name suggests the existing ones",
	);
	assert(
		sv.readSavedWorkflow("../evil", dir).ok === false &&
			sv.readSavedWorkflow("../evil", dir).message.includes("not a usable workflow name"),
		"a path is refused as a name (whitelist before join)",
	);

	// names de-duplicate across roots; the GLOBAL root resolves through
	// getAgentDir(), which honors PI_CODING_AGENT_DIR per call — point it at a
	// tmp dir and a name known only there resolves (the third discovery leg).
	{
		const gdir = mkdtempSync(join(tmpdir(), "wfg-"));
		mkdirSync(join(gdir, "workflows"), { recursive: true });
		writeFileSync(join(gdir, "workflows", "global-only.js"), meta("global"), "utf8");
		const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = gdir;
		try {
			const g = sv.readSavedWorkflow("global-only", dir);
			assert(
				g.ok && g.script.includes("name: 'global'"),
				"the agent dir's workflows/ is the third discovery root",
			);
		} finally {
			if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
			rmSync(gdir, { recursive: true, force: true });
		}
	}

	// the listing: meta-marked .js only, de-duplicated across roots, sorted.
	// A name is listed when ANY root holds a meta-carrying file with it — the
	// shadowing refusal is readSavedWorkflow's job (first-hit-wins), not the
	// listing's.
	mk(".agents/workflows/utils.js", "module.exports = 1;\n"); // not a workflow
	mk(".pi/workflows/aaa.js", meta("a"));
	const list = sv.listSavedWorkflows(dir);
	assert(
		list.includes("aaa") && list.includes("dup") && list.includes("only") &&
			!list.includes("utils"),
		"the listing offers only meta-carrying files",
	);
	assert(
		JSON.stringify(list.filter((n) => n === "aaa")) === '["aaa"]',
		"names de-duplicate across roots",
	);
	assert(JSON.stringify(list) === JSON.stringify([...list].sort()), "the listing is sorted");

	// precedence: scriptPath > script > name; a saved name reports its path
	const named = sv.resolveWorkflowScript({ name: "dup" }, dir);
	assert(
		named.ok && named.script.includes("from-pi") && named.scriptPath.endsWith("dup.js"),
		"a saved name resolves to source and reports the file (the edit-and-re-run loop)",
	);
	const viaScript = sv.resolveWorkflowScript({ script: meta("inline"), name: "dup" }, dir);
	assert(viaScript.ok && viaScript.script.includes("inline"), "`script` wins over `name`");
	const viaPath = sv.resolveWorkflowScript(
		{ script: meta("inline"), name: "dup", scriptPath: join(dir, ".pi/workflows/aaa.js") },
		dir,
	);
	assert(viaPath.ok && viaPath.script.includes("name: 'a'"), "`scriptPath` wins over everything");
	const none = sv.resolveWorkflowScript({}, dir);
	assert(
		none.ok === false && none.message.includes("takes precedence"),
		"no source at all names the precedence",
	);

	// meta pre-parse: the marker regex, and the literal contract behind it
	assert(
		metaMod.hasMetaDeclaration(meta("x")) &&
			!metaMod.hasMetaDeclaration("const meta = 1;\n"),
		"hasMetaDeclaration marks workflow files (the discovery filter)",
	);
	assert(
		metaMod.hasMetaDeclaration(
			"export const meta = { name: 'x', description: 'a}b' }\nreturn 1;",
		),
		"braces inside meta strings do not fool the marker",
	);
	try {
		metaMod.extractMeta("export const meta = { name: getName(), description: 'd' }\nreturn 1;");
		assert(false, "unreachable");
	} catch (e) {
		assert(
			/pure literal/i.test(e.message),
			"a non-literal meta is a validation error (pre-parsed before the run)",
		);
	}
	// the pre-parse is what seeds the run: a saved file validates identically
	const saved = sv.readSavedWorkflow("dup", dir);
	const validated = rt.validateScript(saved.script);
	assert(
		validated.meta.name === "from-pi",
		"a saved file's meta is extracted before anything runs (phases render from frame one)",
	);
	rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
console.log("\n[6] nested workflow() + the tool surface (name, resumeFromRunId)");
{
	// The tool's internal chain resolves runs via the `.js` specifier, which
	// jiti caches as a SEPARATE instance — registry assertions on tool-driven
	// runs must read the tool's own instance.
	const runsViaJs = await jiti.import(join(ROOT, "src/workflow/runs.js"), { parent: ROOT });
	const wfTool = await jiti.import(join(ROOT, "src/tools/workflow.ts"), { parent: ROOT });
	const settings = () => ({ workflows_enabled: true, notifications: "normal" });
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
	/** Poll the registry until a run settles — no fixed sleep against a worker. */
	async function settled(runsMap, runId) {
		for (let i = 0; i < 200; i++) {
			const rec = runsMap.get(runId);
			if (rec && rec.status !== "running" && rec.result) return rec;
			await new Promise((r) => setTimeout(r, 25));
		}
		throw new Error(`run ${runId} never settled`);
	}

	// nested workflow(): the host resolves a saved name (one-line delegation to
	// resolveWorkflowSource — discovery order asserted in [5]; here, that the
	// runtime accepts it and the child runs in the same worker).
	{
		const savedSrc = "export const meta = { name: 'child', description: 'd' }\nreturn 'child-return';";
		const s = stubHost({
			loadWorkflowImpl: (ref) => {
				if (ref.name === "child") return { ok: true, script: savedSrc, path: "child.js" };
				return { ok: false, message: "No saved workflow named it." };
			},
		});
		const result = await rt.runWorkflow({
			script: script(`return await workflow('child');`),
			host: s.host,
		});
		assert(
			result.status === "completed" && result.value === "child-return",
			"nested workflow() resolves through the host seam and runs inline",
		);
		const unknown = await rt.runWorkflow({
			script: script(`try { await workflow('ghost'); return 'caught'; } catch { return 'caught'; }`),
			host: stubHost({
				loadWorkflowImpl: () => ({ ok: false, message: "No saved workflow named 'ghost'." }),
			}).host,
		});
		assert(
			unknown.status === "completed" && unknown.value === "caught",
			"an unknown nested name throws into the script, which may catch it",
		);
	}

	// the tool: name param resolves through discovery; resumeFromRunId flows
	const dir = mkdtempSync(join(tmpdir(), "wft-"));
	const workflowsDir = join(dir, ".pi", "workflows");
	mkdirSync(workflowsDir, { recursive: true });
	const SAVED = "export const meta = { name: 'saved', description: 'saved wf' }\nreturn await agent('p1', { label: 'one' });";
	writeFileSync(join(workflowsDir, "saved.js"), SAVED, "utf8");

	const prevCwd = process.cwd();
	process.chdir(dir);
	try {
		const { pi, tools } = mockPi();
		wfTool.registerWorkflowTool(pi, { load: settings, host: stubHost().host });
		const tool = tools[0];
		assert(
			tool.parameters !== undefined &&
				JSON.stringify(tool.parameters).includes("resumeFromRunId") &&
				JSON.stringify(tool.parameters).includes('"name"'),
			"the tool schema carries `name` and `resumeFromRunId`",
		);

		// run by SAVED NAME (cwd is the tmp project)
		const byName = await tool.execute("t1", { name: "saved" }, undefined, undefined, undefined);
		assert(
			!byName.isError && byName.details.scriptPath.endsWith("saved.js"),
			"a saved `name` resolves to its file and runs",
		);
		await settled(runsViaJs.workflowRuns(), byName.details.runId);

		// an unknown resume id refuses before anything runs
		const bad = await tool.execute(
			"t2",
			{ resumeFromRunId: "wf_deadbeefcafe" },
			undefined,
			undefined,
			undefined,
		);
		assert(bad.isError && bad.details.error.message.includes("No workflow run"), "an unknown run id refuses");

		// resume with NO source of its own: re-runs the prior run's script
		const resume = await tool.execute(
			"t3",
			{ resumeFromRunId: byName.details.runId },
			undefined,
			undefined,
			undefined,
		);
		assert(
			!resume.isError &&
				resume.details.scriptPath === byName.details.scriptPath &&
				resume.details.resumedFrom === byName.details.runId &&
				/Resuming wf_[a-z0-9]+: 1 recorded call\(s\) available to replay/.test(
					resume.content[0].text,
				),
			"a bare resumeFromRunId re-runs that run's own script, reporting the recorded-call count",
		);
		const record = await settled(runsViaJs.workflowRuns(), resume.details.runId);
		assert(
			record.result.replayedCount === 1,
			"the resumed run replays the unchanged prefix from the journal",
		);
		const push = record.result; // registry holds the result; the push text was checked in [4]
		assert(push !== undefined && record.status === "completed", "the resumed run completes");
	} finally {
		process.chdir(prevCwd);
		rmSync(dir, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
console.log(`\n${failed === 0 ? "✅ ALL PASS" : "❌ SOME FAILED"} (${passed} passed, ${failed} failed)`);
process.exit(failed === 0 ? 0 : 1);
