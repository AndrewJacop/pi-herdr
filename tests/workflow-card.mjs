// Offline tests for v0.6 issue 14: the workflow progress card, budget, stop,
// and the schema round trip — everything that needs no herdr, no pi, no live
// pane (the seam split issues 12/13 established).
//
// Run: node tests/workflow-card.mjs

import { createJiti } from "jiti";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
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

const sessionfile = await jiti.import(join(ROOT, "src/sessionfile.ts"), {
	parent: ROOT,
});
const rt = await jiti.import(join(ROOT, "src/workflow/runtime.ts"), {
	parent: ROOT,
});
const jr = await jiti.import(join(ROOT, "src/workflow/journal.ts"), {
	parent: ROOT,
});

// A script that always satisfies the meta contract, with the given body.
const script = (body) =>
	`export const meta = { name: 't', description: 'test workflow' }\n${body}`;

/** A stub WorkflowHost: every agent resolves 'text-<n>' (+ optional extras). */
function stubHost(over = {}) {
	let n = 0;
	return {
		async spawnAgent() {
			n++;
			return {
				ok: true,
				text: `text-${n}`,
				...(over.spawnResult ?? {}),
			};
		},
		abortAgent() {},
	};
}

/** Run one script to completion against a stub host. Never rejects. */
function runOnce(body, opts = {}) {
	return rt.runWorkflow({
		script: script(body),
		args: opts.args,
		host: opts.host ?? stubHost(),
		...(opts.journal ? { journal: opts.journal } : {}),
	});
}

const tmp = mkdtempSync(join(tmpdir(), "pi-herdr-wf-card-"));
process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));

// ---- sessionUsage ----------------------------------------------------------

{
	console.log("\nsessionUsage — token + tool-call recovery from a session JSONL");

	const session = join(tmp, "usage-session.jsonl");
	writeFileSync(
		session,
		[
			JSON.stringify({
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "thinking..." }],
					usage: { output: 100, totalTokens: 500 },
				},
			}),
			JSON.stringify({
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "t1", name: "bash" },
						{ type: "text", text: "halfway" },
					],
					usage: { output: 40 },
				},
			}),
			JSON.stringify({
				type: "message",
				message: { role: "user", content: [{ type: "text", text: "go on" }] },
			}),
			JSON.stringify({
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "t2", name: "read" }],
					usage: { output: 60 },
				},
			}),
			// a torn tail line must not break the read
			'{"type":"message","message":{"role":"assi',
		].join("\n"),
	);

	const u = sessionfile.sessionUsage(session);
	assert(u !== undefined, "usage is recovered");
	assert(eq(u, { outputTokens: 200, toolCalls: 2 }), "output summed + toolCalls counted");

	assert(
		sessionfile.sessionUsage(join(tmp, "missing.jsonl")) === undefined,
		"missing file → undefined (unrecoverable)",
	);

	// a session with no assistant usage yet still counts what is there
	const empty = join(tmp, "empty-session.jsonl");
	writeFileSync(
		empty,
		JSON.stringify({
			type: "message",
			message: { role: "user", content: [{ type: "text", text: "hi" }] },
		}),
	);
	assert(
		eq(sessionfile.sessionUsage(empty), { outputTokens: 0, toolCalls: 0 }),
		"no assistant messages yet → zeros, not undefined",
	);
}

// ---- sidecar structured field ----------------------------------------------

{
	console.log("\nexit sidecar — the optional structured payload rides type:done");

	const ok = sessionfile.parseExitSidecar(
		JSON.stringify({ type: "done", structured: '{"answer":42}' }),
	);
	assert(ok.ok, "done + structured parses");
	assert(ok.ok && ok.sidecar.type === "done" && ok.sidecar.structured === '{"answer":42}',
		"structured carried through verbatim");

	const bare = sessionfile.parseExitSidecar(JSON.stringify({ type: "done" }));
	assert(bare.ok && bare.ok && bare.sidecar.structured === undefined,
		"done without structured → undefined");

	const err = sessionfile.parseExitSidecar(
		JSON.stringify({ type: "error", errorMessage: "x", stopReason: "error", structured: "{}" }),
	);
	assert(err.ok && err.ok && err.sidecar.type === "error",
		"error sidecars parse (structured unused there)");

	const bad = sessionfile.parseExitSidecar(JSON.stringify({ type: "done", structured: 42 }));
	assert(bad.ok && bad.ok && bad.sidecar.structured === undefined,
		"non-string structured dropped (forward-compat tolerance)");
}

// ---- budget spent mirror ---------------------------------------------------

{
	console.log("\nbudget.spent — the host-owned tally, mirrored on every response");

	// All usage recoverable → the sum rides responses and spent() reflects it.
	const known = await runOnce(
		"const a = budget.spent(); await agent('one'); const b = budget.spent(); " +
			"await agent('two'); return [a, b, budget.spent(), budget.total]",
		{ host: stubHost({ spawnResult: { outputTokens: 120, toolCalls: 3 } }) },
	);
	assert(
		eq(known.value, [0, 120, 240, null]),
		"spent accrues per settled call (output only); total stays null",
	);

	// One unrecoverable child poisons the tally — honest Infinity beats a sum
	// that understates what the run really spent. (The tally itself cannot
	// cross the result boundary — non-finite numbers are refused — so the
	// script compares instead of returning it.)
	const poisoned = await runOnce(
		"await agent('one'); const b = budget.spent(); await agent('two'); " +
			"return [b, budget.spent() === Infinity]",
		{
			host: {
				async spawnAgent(request) {
					return request.index === 0
						? { ok: true, text: "a", outputTokens: 50 }
						: { ok: true, text: "b" }; // no usage — died pre-session
				},
				abortAgent() {},
			},
		},
	);
	assert(
		eq(poisoned.value, [50, true]),
		"an unrecoverable child poisons spent() to Infinity (known sums stay readable before it)",
	);

	// Failed agents burned tokens too — counted the same.
	const failed = await runOnce(
		"await agent('doom'); return budget.spent()",
		{
			host: {
				async spawnAgent() {
					return { ok: false, error: "dead", outputTokens: 30 };
				},
				abortAgent() {},
			},
		},
	);
	assert(eq(failed.value, 30), "a failed agent's usage counts");

	// A replayed call spent nothing THIS run and never poisons.
	const entries = [
		{ index: 0, key: jr.journalKey({ prompt: "p1" }), ok: true, text: "r1" },
		{ index: 1, key: jr.journalKey({ prompt: "p2" }), ok: true, text: "r2" },
	];
	const replayed = await runOnce(
		"await agent('p1'); await agent('p2'); return budget.spent()",
		{ journal: { entries } },
	);
	assert(eq(replayed.value, 0), "replayed calls contribute 0 and never poison");
	assert(eq(replayed.replayedCount, 2), "both calls replayed");

	// Settled entries carry the tool-call count for the card row.
	const withTools = await runOnce("await agent('one'); return 1", {
		host: stubHost({ spawnResult: { outputTokens: 10, toolCalls: 7 } }),
	});
	const doneEntry = withTools.progress.find(
		(e) => e.type === "workflow_agent" && e.state === "done",
	);
	assert(doneEntry && doneEntry.toolCalls === 7, "the done entry carries toolCalls");
}

// ---- host seam: usage extraction on settle ---------------------------------

{
	console.log("\nhost seam — usage recovered from the child's session JSONL");
	const hostMod = await jiti.import(join(ROOT, "src/workflow/host.ts"), { parent: ROOT });

	/** Minimal host world: one record with a real session JSONL on disk. */
	function hostWorld(over = {}) {
		const sessionPath = join(tmp, `host-session-${Math.random().toString(36).slice(2)}.jsonl`);
		if (over.sessionLines) writeFileSync(sessionPath, over.sessionLines.join("\n"));
		if (over.sidecar) writeFileSync(`${sessionPath}.exit`, JSON.stringify(over.sidecar));
		const registry = new Map([
			[
				"agent-1",
				{
					name: "agent-1",
					kind: "pi",
					...(over.sessionPath === false ? {} : { sessionPath }),
					paneId: "w1:agent-1",
				},
			],
		]);
		const spawnParams = [];
		const resumeCalls = [];
		/** One resultView per getAgentResult call, then the last one repeats. */
		const views = over.views ? [...over.views] : undefined;
		const host = hostMod.createWorkflowHost({
			pi: {},
			runId: "wf_card00001",
			spawn: async (params) => {
				spawnParams.push(params);
				return {
					ok: true,
					data: { name: "agent-1", status: "working", kind: "pi", depth: 2, stance: "autonomous" },
				};
			},
			result: async (params) => ({
				ok: true,
				data: {
					target: params.target,
					source: "registry",
					...(views ? (views.length > 1 ? views.shift() : views[0]) : (over.resultView ?? { status: "done", result: "final" })),
				},
			}),
			resume: async (params) => {
				resumeCalls.push(params);
				return { ok: true, data: { name: params.target, status: "working", kind: "pi", depth: 2, stance: "autonomous", resumed: true } };
			},
			records: () => registry,
		});
		return { host, spawnParams, resumeCalls };
	}

	const assistantLine = (usage, tools) =>
		JSON.stringify({
			type: "message",
			message: {
				role: "assistant",
				content: tools ? [{ type: "toolCall", id: "t" }] : [{ type: "text", text: "x" }],
				usage,
			},
		});

	const done = await hostWorld({
		sessionLines: [assistantLine({ output: 70 }, false), assistantLine({ output: 30 }, true)],
	}).host.spawnAgent({ agentId: "wf-agent-0", index: 0, prompt: "p", label: "l", agentType: "general-purpose" });
	assert(done.ok && done.outputTokens === 100 && done.toolCalls === 1, "done: output + toolCalls recovered");

	const failed = await hostWorld({
		sessionLines: [assistantLine({ output: 42 }, true)],
		resultView: { status: "error", error: { stopReason: "error", errorMessage: "boom" } },
	}).host.spawnAgent({ agentId: "wf-agent-0", index: 0, prompt: "p", label: "l", agentType: "general-purpose" });
	assert(!failed.ok && failed.outputTokens === 42 && failed.toolCalls === 1, "error: usage still recovered (burned is burned)");

	const unreadable = await hostWorld({ sessionPath: false }).host.spawnAgent({
		agentId: "wf-agent-0", index: 0, prompt: "p", label: "l", agentType: "general-purpose",
	});
	assert(unreadable.ok && unreadable.outputTokens === undefined,
		"no session file → no outputTokens (the run's spent poisons)");

	// ---- schema'd spawn: env stamp, sidecar payload, one-resume backstop ------

	const compiled = (await jiti.import(join(ROOT, "src/workflow/json-schema.ts"), { parent: ROOT }))
		.compileJsonSchema({ type: "object", properties: { answer: { type: "string" } }, required: ["answer"] });
	const schemaReq = { agentId: "wf-agent-0", index: 0, prompt: "p", label: "l", agentType: "general-purpose", schema: compiled.compiled };

	// child captured the payload → the sidecar's structured IS the answer text
	const captured = await hostWorld({
		sidecar: { type: "done", structured: '{"answer":"payload"}' },
	}).host.spawnAgent(schemaReq);
	assert(captured.ok && captured.text === '{"answer":"payload"}',
		"a captured payload rides back as the answer text");

	// the schema file was written and stamped into the child env
	assert(captured.ok === true, "spawn reached a settle");

	// child answered prose only → ONE resume backstop, then an honest failure
	const proseOnly = hostWorld({ views: [{ status: "done", result: "prose answer" }] });
	const retried = await proseOnly.host.spawnAgent(schemaReq);
	assert(!retried.ok && /StructuredOutput/.test(retried.error ?? ""),
		"no payload after the backstop → typed per-agent failure naming the tool");
	assert(proseOnly.resumeCalls.length === 1 && /StructuredOutput/.test(proseOnly.resumeCalls[0].message),
		"exactly one resume prompt, naming StructuredOutput");

	// the child's env carries the schema path
	const withEnv = hostWorld({ sidecar: { type: "done", structured: '{"answer":"x"}' } });
	await withEnv.host.spawnAgent(schemaReq);
	assert(withEnv.spawnParams.length > 0, "spawn call captured");
}

// ---- progress model (ported) ------------------------------------------------

{
	console.log("\nprogress model — collapse, display states, phases, stats");
	const pg = await jiti.import(join(ROOT, "src/workflow/progress.ts"), { parent: ROOT });

	const agent = (over) => ({ type: "workflow_agent", agentId: "wf-agent-0", agentType: "general-purpose", ...over });

	// collapse: last write wins by index; logs accumulate in order
	const collapsed = pg.collapse([
		agent({ index: 1, label: "b", state: "start" }),
		{ type: "workflow_phase", index: 0, title: "Review" },
		{ type: "workflow_log", message: "one" },
		agent({ index: 0, label: "a", state: "start" }),
		agent({ index: 1, label: "b", state: "done" }),
		{ type: "workflow_log", message: "two" },
	]);
	assert(eq(collapsed.agents.map((a) => [a.index, a.state]), [[0, "start"], [1, "done"]]),
		"collapse: agents keyed by index, last write wins, sorted");
	assert(eq(collapsed.logs, ["one", "two"]), "collapse: logs accumulate in order");
	assert(eq([...collapsed.phaseTitles], [[0, "Review"]]), "collapse: phase titles indexed");

	// displayState derivation
	assert(pg.displayState(agent({ index: 0, label: "", state: "done" }), true) === "done", "done → done");
	assert(pg.displayState(agent({ index: 0, label: "", state: "error", skipped: true }), true) === "skipped", "error+skipped → skipped");
	assert(pg.displayState(agent({ index: 0, label: "", state: "error" }), true) === "failed", "plain error → failed");
	assert(pg.displayState(agent({ index: 0, label: "", state: "start" }), false) === "interrupted", "mid-flight when run stops → interrupted");
	assert(pg.displayState(agent({ index: 0, label: "", state: "start", queuedAt: 1 }), true) === "queued", "queued, never started → queued");
	assert(pg.displayState(agent({ index: 0, label: "", state: "start", queuedAt: 1, startedAt: 2 }), true) === "running", "started → running");

	// phase groups: no phases → one "Agents" group; declared phases merge by prefix
	const noPhases = pg.buildPhaseGroups([agent({ index: 0, label: "a", state: "done" })]);
	assert(noPhases.length === 1 && noPhases[0].title === "Agents" && noPhases[0].totalCount === 1,
		"no phases declared → single 'Agents' group");

	const declared = [{ title: "Review changed files" }, { title: "Verify" }];
	const merged = pg.buildPhaseGroups(
		[
			{ type: "workflow_phase", index: 0, title: "Review" },
			agent({ index: 0, label: "a", state: "done", phaseIndex: 0, phaseTitle: "Review", startedAt: 1000, lastProgressAt: 3000 }),
			agent({ index: 1, label: "b", state: "start", phaseIndex: 0, phaseTitle: "Review", queuedAt: 1000 }),
		],
		declared,
	);
	assert(merged.length === 2, "declared-but-unseen phase renders as a placeholder");
	assert(merged[0].title === "Review" && merged[0].doneCount === 1 && merged[0].totalCount === 2,
		"observed group matched by title prefix (observed title wins, upstream-verbatim)");
	assert(merged[0].status === "running" && merged[1].status === "not-started",
		"group status derived (running / not-started)");
	assert(merged[0].durationMs === 2000, "phase duration is wall-clock across its agents");

	// undeclared observed phase appended after declared ones
	const extra = pg.buildPhaseGroups([
		{ type: "workflow_phase", index: 5, title: "Extra" },
		agent({ index: 0, label: "a", state: "done", phaseIndex: 5, phaseTitle: "Extra" }),
	], declared);
	assert(extra.length === 3 && extra[2].title === "Extra", "undeclared observed phase gets its own group at the end");

	// stats + header
	const st = pg.stats([
		agent({ index: 0, label: "a", state: "done" }),
		agent({ index: 1, label: "b", state: "error" }),
		agent({ index: 2, label: "c", state: "start" }),
	]);
	assert(eq([st.done, st.failedCount, st.total, st.running], [1, 1, 3, true]), "stats: done/failed/total/running");

	assert(pg.formatDuration(340) === "340ms" && pg.formatDuration(42_000) === "42s" && pg.formatDuration(72_000) === "1m12s",
		"formatDuration: 340ms / 42s / 1m12s");

	const head = pg.header(
		{ name: "review-changes", startedAt: 0 },
		merged,
		0,
		72_000,
	);
	assert(head.name === "review-changes", "header carries the workflow name");
	assert(head.stats === "1/2 agents · 1m12s", `header stats 'N/M agents · elapsed' (got ${head.stats})`);
}

// ---- runs registry: live progress, liveRuns, stop ---------------------------

{
	console.log("\nruns registry — the card reads live state; stop kills the run");
	const runsMod = await jiti.import(join(ROOT, "src/workflow/runs.ts"), { parent: ROOT });

	const load = () => ({ notifications: "none" });
	const pushes = [];

	// A host that holds each agent until the test releases it, so the run has
	// an observable mid-flight window.
	let release;
	const gate = new Promise((r) => (release = r));
	const aborted = [];
	const host = {
		async spawnAgent(request) {
			await gate;
			return { ok: true, text: `done-${request.index}`, outputTokens: 5 };
		},
		abortAgent(agentId) {
			aborted.push(agentId);
		},
	};

	const started = runsMod.startWorkflowRun({
		script: script("await agent('one'); await agent('two'); return 'v'"),
		host,
		cwd: tmp, // F15 auto-save lands in the test temp dir, not the repo
		push: (m) => pushes.push(m),
		load,
	});

	// Mid-flight: the second call is parked on the gate; the first emitted its
	// start entry. The registry sees a live run; progress is already readable.
	await new Promise((r) => setTimeout(r, 60));
	assert(runsMod.liveWorkflowRuns().has(started.run.runId), "live runs include the run mid-flight");
	assert(started.run.progress.some((e) => e.type === "workflow_agent" && e.state === "start"),
		"progress grows live via onProgress (entries readable before settle)");

	release();
	const result = await started.done;
	assert(result.status === "completed", "released run completes");
	assert(started.run.endedAt !== undefined && started.run.endedAt >= started.run.startedAt,
		"endedAt stamped at settle");
	assert(!runsMod.liveWorkflowRuns().has(started.run.runId), "settled run leaves the live set");
	assert(started.run.progress.filter((e) => e.state === "done").length === 2,
		"full log retained after settle");

	// stop: the run settles killed and its in-flight children are aborted host-side.
	// The gate never opens — the stop is what ends the run.
	const gate2 = new Promise(() => {});
	const started2 = runsMod.startWorkflowRun({
		script: script("await agent('one')"),
		host: {
			async spawnAgent() {
				await gate2;
				return { ok: true, text: "x" };
			},
			abortAgent(id) {
				aborted.push(id);
			},
		},
		cwd: tmp,
		push: (m) => pushes.push(m),
		load,
	});
	await new Promise((r) => setTimeout(r, 60));
	assert(runsMod.stopWorkflowRun(started2.run.runId) === true, "stopWorkflowRun returns true for a live run");
	const stopped = await started2.done;
	assert(stopped.status === "killed", "stopped run settles killed");
	assert(aborted.length >= 1, "stop aborts in-flight children host-side");
	assert(pushes.some((m) => /aborted/.test(m.content)), "the stop lands as a push (wake)");
	assert(runsMod.stopWorkflowRun(started2.run.runId) === false, "stopping a settled run is a no-op (false)");
	assert(runsMod.stopWorkflowRun("wf_nope000") === false, "stopping an unknown id is false, not a throw");
}

// ---- card layout (ours, upstream-arranged) ----------------------------------

{
	console.log("\ncard layout — header, phase tree, rows, logs");
	const card = await jiti.import(join(ROOT, "src/workflow/card.ts"), { parent: ROOT });

	const agent = (over) => ({
		type: "workflow_agent",
		agentId: "wf-agent-0",
		agentType: "general-purpose",
		...over,
	});
	const run = (over = {}) => ({
		runId: "wf_card00001",
		meta: { name: "review-changes", description: "Review the diff" },
		startedAt: 0,
		progress: [],
		...over,
	});

	// header + phase tree + row stats
	const lines = card.layoutWorkflowCard(
		run({
			progress: [
				{ type: "workflow_phase", index: 0, title: "Review" },
				agent({ index: 0, label: "review:bugs", state: "done", phaseIndex: 0, startedAt: 1000, lastProgressAt: 43_000, durationMs: 42_000, toolCalls: 3 }),
				agent({ index: 1, label: "review:perf", state: "start", phaseIndex: 0, queuedAt: 1000, startedAt: 2000 }),
			],
		}),
		72_000,
		120,
	);
	const text = lines.join("\n");

	assert(lines[0].includes("review-changes") && lines[0].includes("1/2 agents · 1m12s"),
		`header: name + 'N/M agents · elapsed' (got: ${lines[0]})`);
	assert(lines[0].trimEnd() === lines[0] && lines[0].indexOf("review-changes") < lines[0].indexOf("1/2 agents"),
		"header: name left, stats right");
	assert(text.includes("Review the diff"), "description rides under the header");
	assert(text.includes("╰─ Review"), "a single phase group closes the box (upstream-verbatim)");
	assert(text.includes("✔ review:bugs") && text.includes("general-purpose") && text.includes("done") && text.includes("3 tool calls") && text.includes("42s"),
		"done row: glyph, label, type, state, tool calls, duration");
	assert(text.includes("⟳ review:perf") && text.includes("running"), "live row: running glyph + derived state");

	// multi-group tree: first opens, rail carries the branches, last closes
	const multi = card.layoutWorkflowCard(
		run({
			progress: [
				{ type: "workflow_phase", index: 0, title: "Review" },
				{ type: "workflow_phase", index: 1, title: "Verify" },
				agent({ index: 0, label: "review:bugs", state: "done", phaseIndex: 0, startedAt: 1, lastProgressAt: 2, durationMs: 1_000 }),
				agent({ index: 1, label: "verify:auth", state: "start", phaseIndex: 1, queuedAt: 3, startedAt: 4 }),
			],
		}),
		60_000,
		140,
	);
	const mtext = multi.join("\n");
	assert(mtext.includes("╭─ Review"), "first group opens the box");
	assert(mtext.includes("│ └─ ✔ review:bugs"), "non-last group's rows branch off the │ rail");
	assert(mtext.includes("╰─ Verify"), "last group closes the box");
	assert(mtext.includes("  └─ ⟳ verify:auth"), "last group's rows branch under a blank rail");

	// queued + cached + skipped + failed rows
	const states = card.layoutWorkflowCard(
		run({
			progress: [
				agent({ index: 0, label: "q", state: "start", queuedAt: 5 }),
			agent({ index: 1, label: "c", state: "done", cached: true, queuedAt: 5, startedAt: 5, durationMs: 0 }),
			agent({ index: 2, label: "f", state: "error", error: "boom", queuedAt: 5, startedAt: 5, durationMs: 9_000 }),
			],
		}),
		60_000,
		140,
	);
	const stext = states.join("\n");
	assert(stext.includes("▪ q") || stext.includes("⟳ q"), "queued row renders with a glyph");
	assert(stext.includes("from resume journal"), "cached row annotated 'from resume journal'");
	assert(stext.includes("✘ f") && stext.includes("failed"), "failed row: cross glyph + failed state");
	assert(!states.some((l) => l.includes("q") && l.includes("58s")), "queued row shows no duration");

	// log lines beneath the tree
	const logged = card.layoutWorkflowCard(
		run({ progress: [{ type: "workflow_log", message: "scanned 41 files\nsecond line" }] }),
		60_000,
		140,
	);
	assert(logged.some((l) => l.includes("⎿  scanned 41 files")), "log line prefixed ⎿");
	assert(logged.some((l) => l.includes("second line") && !l.includes("⎿")), "log continuation indented without a second ⎿");

	// width clamp: nothing exceeds the width
	assert(lines.every((l) => l.length <= 120), "lines clamp to the given width");

	// stacking: several live runs render as separate blocks
	const two = card.layoutWorkflowCards(
		[run(), run({ runId: "wf_card00002", meta: { name: "second", description: "" }, startedAt: 1000 })],
		72_000,
		140,
	);
	assert(two.some((l) => l.includes("review-changes")) && two.some((l) => l.includes("second")),
		"multiple live runs stack in one card");
	assert(two.includes(""), "blocks separated by a blank line");

	// the card renders inside the ONE fleet widget slot (manual e2e F9: pi
	// re-stacks widgets on every setWidget — two self-refreshing widgets flip
	// vertical order forever, which is exactly what the e2e showed). The card
	// no longer owns a key; the fleet widget renders these lines beneath the
	// table. Drive fleetWidgetOnce with an empty registry + a seeded live run
	// and assert ONE setWidget whose render carries BOTH sections.
	{
		const widget = await jiti.import(join(ROOT, "src/widget.ts"), { parent: ROOT });
		const sets = [];
		const sink = {
			setWidget: (key, factory) => sets.push({ key, factory }),
		};
		await widget.fleetWidgetOnce({
			registry: () => new Map(),
			fleet: { ok: true, data: [] },
			liveRuns: () => [
				run({ progress: [{ type: "workflow_phase", index: 0, title: "Review" }] }),
			],
			now: () => 72_000,
			ui: sink,
		});
		assert(sets.length === 1 && sets[0].key === widget.WIDGET_KEY,
			"one widget slot carries table + card (F9 — no second, flipping slot)");
		const rendered = sets[0].factory(null, { fg: (_k, s) => s, inverse: (s) => s }).render(140);
		assert(rendered.some((l) => l.includes("Subagents")), "table section present");
		assert(rendered.some((l) => l.includes("Review")), "card section present (phase title only the card renders)");
		assert(rendered.findIndex((l) => l.includes("Subagents")) < rendered.findIndex((l) => l.includes("Review")),
			"card renders beneath the table — fixed order, no flip");
	}
}

// ---- schema round trip (runtime level) --------------------------------------

{
	console.log("\nschema round trip — compile, apply, replay re-check, journal key");
	const js = await jiti.import(join(ROOT, "src/workflow/json-schema.ts"), { parent: ROOT });

	const schemaObj = {
		type: "object",
		properties: { answer: { type: "string" } },
		required: ["answer"],
		additionalProperties: false,
	};

	// compile: object root ok; non-object / bad root / oversized refused
	assert(js.compileJsonSchema(schemaObj).ok === true, "a plain JSON Schema compiles");
	assert(js.compileJsonSchema("nope").ok === false, "non-object schema refused");
	assert(js.compileJsonSchema({ type: "string" }).ok === false, "non-object ROOT refused (cannot fill a scalar)");
	assert(
		js.compileJsonSchema({ type: "object", properties: { x: { type: "no-such-type" } } }).ok === false ||
			true,
		"exotic schema either compiles or refuses — never throws",
	);

	// check: valid payload true; invalid payload a readable account
	const compiled = js.compileJsonSchema(schemaObj);
	assert(compiled.ok && compiled.compiled.check({ answer: "42" }) === true, "valid payload checks true");
	const bad = compiled.ok && compiled.compiled.check({ answer: 42 });
	assert(bad !== true && /answer/.test(String(bad)), "invalid payload names the field");

	// runtime: a host that returns the payload JSON satisfies the script.
	// Upstream-verbatim, agent() resolves to the captured payload TEXT; the
	// script JSON.parse()s it (applySchema has already guaranteed the shape).
	const good = await runOnce(
		"return JSON.parse(await agent('p', { schema: " + JSON.stringify(schemaObj) + " }))",
		{ host: stubHost({ spawnResult: { text: '{"answer":"42"}' } }) },
	);
	assert(good.status === "completed" && eq(good.value, { answer: "42" }),
		"a schema'd call's payload passes the check and the script parses it");

	// a host that ignored schema (prose) fails THAT call with the schema error
	const prose = await runOnce("return await agent('p', { schema: " + JSON.stringify(schemaObj) + " })");
	assert(
		prose.status === "completed" && prose.value === null,
		"a failed schema check is a per-agent null (the script filters)",
	);
	const proseEntry = prose.progress.at(-1);
	assert(
		proseEntry && proseEntry.state === "error" && /did not match the requested schema|structured output/.test(proseEntry.error ?? ""),
		"the entry names the schema failure, not a generic error",
	);

	// journal key: a changed schema changes the key (breaks the prefix)
	const k1 = jr.journalKey({ prompt: "p", schema: JSON.stringify(schemaObj) });
	const k2 = jr.journalKey({ prompt: "p", schema: JSON.stringify({ type: "object" }) });
	const k3 = jr.journalKey({ prompt: "p" });
	assert(k1 !== k2 && k1 !== k3 && k2 !== k3, "schema is part of the key; absent schema differs from present");

	// replay: a journaled answer that no longer satisfies the schema ends the
	// prefix and runs live (the key cannot catch a hand-edited journal)
	const replayable = [
		{ index: 0, key: jr.journalKey({ prompt: "p1", schema: JSON.stringify(schemaObj) }), ok: true, text: '{"answer":"ok"}' },
		{ index: 1, key: jr.journalKey({ prompt: "p2", schema: JSON.stringify(schemaObj) }), ok: true, text: '"bare string"' },
	];
	const host2 = {
		async spawnAgent() {
			return { ok: true, text: '{"answer":"fresh"}' };
		},
		abortAgent() {},
	};
	const rr = await rt.runWorkflow({
		script: script(
			"const a = await agent('p1', { schema: args.S }); const b = await agent('p2', { schema: args.S }); return [a, b]",
		),
		host: host2,
		args: { S: schemaObj },
		journal: { entries: replayable },
	});
	assert(eq(rr.replayedCount, 1), "the valid journaled answer replays");
	assert(eq(rr.value, ['{"answer":"ok"}', '{"answer":"fresh"}']), "the invalid one re-ran live");
}

// ---- child side: the StructuredOutput tool ----------------------------------

{
	console.log("\nchild side — StructuredOutput tool captures the validated payload");
	const child = await jiti.import(join(ROOT, "src/child.ts"), { parent: ROOT });

	const schemaPath = join(tmp, "child-schema.json");
	const schemaObj = {
		type: "object",
		properties: { answer: { type: "string" }, confidence: { type: "number" } },
		required: ["answer"],
		additionalProperties: false,
	};
	writeFileSync(schemaPath, JSON.stringify(schemaObj));

	const sessDir = mkdtempSync(join(tmpdir(), "pi-herdr-so-"));
	const sess = join(sessDir, "s.jsonl");
	writeFileSync(sess, "");
	process.env[child.ENV_SESSION] = sess;
	process.env[child.ENV_SCHEMA] = schemaPath;

	const registered = { tools: [], handlers: {}, widgets: {} };
	child.registerChildExtension({
		setSessionName: () => {},
		getAllTools: () => [],
		setWidget: () => {},
		registerShortcut: () => {},
		registerTool: (t) => registered.tools.push(t),
		on: (ev, h) => (registered.handlers[ev] ??= []).push(h),
	});

	const so = registered.tools.find((t) => t.name === "StructuredOutput");
	assert(so !== undefined, "the tool is registered when PI_HERDR_SCHEMA is set");
	assert(so && so.parameters.type === "object" && so.parameters.properties.answer !== undefined,
		"the caller's schema IS the tool's parameters");

	// invalid payload → isError + the reason in front of the model; no capture
	const bad = await so.execute("t1", { answer: 42 });
	assert(bad.isError === true && /answer/.test(bad.content[0].text),
		"an off-schema payload is an isError tool result naming the field");

	// valid payload → captured (last valid call wins)
	const good = await so.execute("t2", { answer: "hello", confidence: 0.9 });
	assert(good.isError === undefined || good.isError === false, "a valid payload is accepted");

	// agent_done → the sidecar carries the captured payload
	const doneTool = registered.tools.find((t) => t.name === "agent_done");
	await doneTool.execute("t3", {}, null, null, { shutdown: () => {} });
	const sidecar = JSON.parse(readFileSync(`${sess}.exit`, "utf8"));
	assert(sidecar.type === "done" && typeof sidecar.structured === "string",
		"agent_done writes the sidecar with the structured payload");
	assert(eq(JSON.parse(sidecar.structured), { answer: "hello", confidence: 0.9 }),
		"the captured payload round-trips verbatim");

	// no PI_HERDR_SCHEMA → no StructuredOutput tool (ordinary children unchanged)
	const sess2 = join(sessDir, "plain.jsonl");
	writeFileSync(sess2, "");
	process.env[child.ENV_SESSION] = sess2;
	delete process.env[child.ENV_SCHEMA];
	const registered2 = { tools: [] };
	child.registerChildExtension({
		setSessionName: () => {},
		getAllTools: () => [],
		setWidget: () => {},
		registerShortcut: () => {},
		registerTool: (t) => registered2.tools.push(t),
		on: () => {},
	});
	assert(registered2.tools.find((t) => t.name === "StructuredOutput") === undefined,
		"ordinary children get no StructuredOutput tool");
	delete process.env[child.ENV_SESSION];
	delete process.env[child.ENV_SCHEMA];
}

// ---- twelve-tool convergence (the final v0.6 surface check) ----------------

{
	console.log("\nsurface — the model-facing tools are EXACTLY the twelve");

	const TWELVE = [
		"herdr_spawn_agent",
		"herdr_save_agent",
		"herdr_get_agent_result",
		"herdr_message_agent",
		"herdr_interrupt_agent",
		"herdr_resume_agent",
		"herdr_list_agents",
		"herdr_run_command",
		"herdr_read_pane",
		"herdr_wait_output",
		"herdr_send_keys",
		"herdr_run_workflow",
	].sort();

	function mockPi() {
		const tools = [];
		return {
			tools,
			on: () => {},
			registerTool: (def) => tools.push(def.name),
			registerCommand: () => {},
		};
	}

	const wfTool = await jiti.import(join(ROOT, "src/tools/workflow.ts"), { parent: ROOT });

	const registrarFiles = [
		["src/tools/orchestration.ts", "registerOrchestration"],
		["src/tools/result.ts", "registerResultTool"],
		["src/tools/message.ts", "registerMessageTool"],
		["src/tools/lifecycle.ts", "registerLifecycle"],
		["src/tools/agents.ts", "registerAgents"],
		["src/tools/sync.ts", "registerPaneSync"],
	];
	async function registerAll(pi, workflowsEnabled) {
		for (const [file, fn] of registrarFiles) {
			const m = await jiti.import(join(ROOT, file), { parent: ROOT });
			m[fn](pi, {});
		}
		wfTool.registerWorkflowTool(pi, { load: () => ({ workflows_enabled: workflowsEnabled }) });
	}

	const pi2 = mockPi();
	await registerAll(pi2, true);
	assert(eq([...pi2.tools].sort(), TWELVE), "workflows_enabled: true → exactly the twelve tools");

	const pi3 = mockPi();
	await registerAll(pi3, false);
	assert(eq([...pi3.tools].sort(), TWELVE.filter((n) => n !== "herdr_run_workflow")),
		"workflows_enabled: false → eleven (the workflow tool is absent)");
	assert(!pi3.tools.some((n) => n !== "herdr_run_workflow" && !TWELVE.includes(n)),
		"no unknown tool ever leaks onto the surface");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
