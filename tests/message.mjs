// Offline tests for the open message channel (issue 05): the resolution chain
// (pane-id / herdr name / registry handle / reserved orchestrator role, real
// names beating reserved), physics-adaptive delivery (blocked → raw answer,
// otherwise enveloped), the receipt shapes, and the spawner-declared `from`
// identity chain.
//
// No live herdr server required: every herdr-facing seam is injected.
//
// Run: node tests/message.mjs

import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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

const msg = await jiti.import(join(ROOT, "src/tools/message.ts"), {
	parent: ROOT,
});
const spawnMod = await jiti.import(join(ROOT, "src/spawn.ts"), { parent: ROOT });

// ---- seam helpers -------------------------------------------------------------

const okGet = (paneId, name, status) => async () => ({
	ok: true,
	data: { paneId, name, status },
});
const notFound = () => async () => ({
	ok: false,
	error: { code: "NOT_FOUND", message: "no such agent" },
});
const recorder = () => {
	const calls = [];
	const fn = async (paneId, text, opts = {}) => {
		calls.push({ paneId, text, opts });
		return { ok: true, data: true };
	};
	fn.calls = calls;
	return fn;
};
/** A registry record like spawnAgent leaves behind. */
const record = (over = {}) => ({
	name: "scout",
	kind: "pi",
	type: "Explore",
	prompt: "do things",
	agentArgs: [],
	depth: 2,
	isolated: false,
	spawnedAt: 1,
	submitted: true,
	sawWorking: true,
	paneId: "w1:p9",
	stance: "interactive",
	...over,
});
const registryWith = (records) => () => {
	const m = new Map();
	for (const r of records) m.set(r.name, r);
	return m;
};
const DEPS = (over = {}) => ({
	registry: registryWith([]),
	agentGet: okGet("w1:p1", "scout", "idle"),
	send: recorder(),
	env: {},
	...over,
});

// ---------------------------------------------------------------------------
console.log("\n[1] Resolution chain — pane-id, herdr name, enrichment");
{
	const send = recorder();
	const r = await msg.messageAgent(
		{ target: "w1:p3", text: "hello" },
		DEPS({ agentGet: okGet("w1:p3", "scout", "idle"), send }),
	);
	assert(r.ok, "pane-id target resolves");
	assert(r.data.target === "w1:p3", "receipt carries the resolved pane id");
	assert(r.data.to === "scout", "to = herdr name");
	assert(send.calls[0].paneId === "w1:p3", "send hit the resolved pane");

	// registry enrichment: addressed by pane id, named by the spawn handle
	const r2 = await msg.messageAgent(
		{ target: "w1:p9", text: "hello" },
		DEPS({
			agentGet: okGet("w1:p9", "scout", "working"),
			registry: registryWith([record()]),
		}),
	);
	assert(r2.ok && r2.data.name === "scout", "byPane match names the handle");
}

console.log("\n[2] Resolution chain — registry handle states");
{
	// gone: herdr knows no such pane, registry does
	const gone = await msg.messageAgent(
		{ target: "scout", text: "hello" },
		DEPS({
			agentGet: notFound(),
			registry: registryWith([record()]),
		}),
	);
	assert(!gone.ok && gone.error.code === "NOT_FOUND", "gone handle errors");
	assert(
		gone.error.message.includes('"scout"') &&
			gone.error.message.includes("herdr_list_agents"),
		"gone error names the handle and points at list_agents",
	);

	// queued: accepted over the cap, no pane yet — nothing to deliver to
	const queued = await msg.messageAgent(
		{ target: "late", text: "hello" },
		DEPS({
			agentGet: notFound(),
			registry: registryWith([record({ name: "late", paneId: undefined })]),
		}),
	);
	assert(!queued.ok, "queued handle errors (no pane exists to type into)");
	assert(
		queued.error.message.includes("queued") &&
			queued.error.message.includes('"late"'),
		"queued error names the handle and the queued state",
	);

	// never started: deferred start failed
	const dead = await msg.messageAgent(
		{ target: "doa", text: "hello" },
		DEPS({
			agentGet: notFound(),
			registry: registryWith([
				record({
					name: "doa",
					paneId: undefined,
					startError: "boot gate timed out",
				}),
			]),
		}),
	);
	assert(
		dead.ok === false && dead.error.message.includes("never started"),
		"startError reads as never-started, not queued",
	);

	// transport failure ≠ gone — pass through honestly
	const transport = await msg.messageAgent(
		{ target: "scout", text: "hello" },
		DEPS({
			agentGet: async () => ({
				ok: false,
				error: { code: "HERDR_UNAVAILABLE", message: "server unreachable" },
			}),
			registry: registryWith([record()]),
		}),
	);
	assert(
		transport.ok === false &&
			transport.error.code === "HERDR_UNAVAILABLE",
		"transport error passes through (not misreported as gone)",
	);
}

console.log("\n[3] Reserved role — orchestrator");
{
	// unset env: the honest error
	const human = await msg.messageAgent(
		{ target: "orchestrator", text: "hello" },
		DEPS({ agentGet: notFound() }),
	);
	assert(!human.ok && human.error.code === "NOT_FOUND", "unset env errors");
	assert(
		human.error.message.includes("no orchestrator above you"),
		"honest wording: no orchestrator above you / answer in-conversation",
	);

	// set env resolves to the spawner's pane (herdr knows the pane id, not
	// the role name — the stub answers by target like the real CLI)
	const env = { PI_HERDR_ORCHESTRATOR_PANE: "w1:p0" };
	const send = recorder();
	const up = await msg.messageAgent(
		{ target: "orchestrator", text: "status?" },
		DEPS({
			agentGet: async (t) =>
				t === "w1:p0"
					? { ok: true, data: { paneId: "w1:p0", name: "the-boss", status: "working" } }
					: { ok: false, error: { code: "NOT_FOUND", message: "no such agent" } },
			env,
			send,
		}),
	);
	assert(up.ok && up.data.target === "w1:p0", "env pane resolves");
	assert(up.data.to === "orchestrator", "to = the role label");
	assert(send.calls[0].paneId === "w1:p0", "sent to the orchestrator pane");

	// set env but the orchestrator pane died
	const deadAbove = await msg.messageAgent(
		{ target: "orchestrator", text: "status?" },
		DEPS({ agentGet: notFound(), env }),
	);
	assert(
		deadAbove.ok === false &&
			deadAbove.error.message.includes("w1:p0"),
		"dead orchestrator pane errors naming the pane",
	);

	// a REAL agent named orchestrator beats the reserved role
	const real = await msg.messageAgent(
		{ target: "orchestrator", text: "hello" },
		DEPS({ agentGet: okGet("w1:p7", "orchestrator", "idle") }),
	);
	assert(
		real.ok && real.data.target === "w1:p7" && real.data.to === "orchestrator",
		"real herdr agent named orchestrator wins (resolved before env consult)",
	);
	assert(!("name" in real.data), "no registry handle claimed for a foreign agent");
}

console.log("\n[4] No match");
{
	const none = await msg.messageAgent(
		{ target: "who-is-this", text: "hello" },
		DEPS({ agentGet: notFound() }),
	);
	assert(!none.ok && none.error.code === "NOT_FOUND", "unknown target errors");
	assert(
		none.error.message.includes("who-is-this") &&
			none.error.message.includes("herdr_list_agents"),
		"error names the target and points at list_agents",
	);
}

console.log("\n[5] Physics-adaptive delivery");
{
	// idle → enveloped
	const send = recorder();
	const idle = await msg.messageAgent(
		{ target: "scout", text: "focus on auth" },
		DEPS({ agentGet: okGet("w1:p1", "scout", "idle"), send }),
	);
	const idleText = send.calls[0].text;
	assert(idle.ok && idle.data.delivery === "message", "idle → message receipt");
	assert(
		idleText.startsWith('<agent-message from="session" to="scout">') &&
			idleText.trimEnd().endsWith("</agent-message>") &&
			idleText.includes("focus on auth"),
		"idle payload is enveloped (from/to attributes + text inside)",
	);
	assert(idle.data.state === "idle", "receipt carries the observed state");

	// working → enveloped too
	const working = await msg.messageAgent(
		{ target: "scout", text: "x" },
		DEPS({ agentGet: okGet("w1:p1", "scout", "working"), send: recorder() }),
	);
	assert(working.data.delivery === "message", "working queues enveloped");

	// blocked → RAW text into the overlay (the message IS the answer)
	const bsend = recorder();
	const blocked = await msg.messageAgent(
		{ target: "scout", text: "option 2" },
		DEPS({ agentGet: okGet("w1:p1", "scout", "blocked"), send: bsend }),
	);
	assert(
		blocked.ok && blocked.data.delivery === "answer",
		"blocked → answer receipt",
	);
	assert(
		eq(bsend.calls[0].text, "option 2"),
		"blocked payload is the raw text — no envelope",
	);

	// submit plumbing
	const withSub = await msg.messageAgent(
		{ target: "scout", text: "x", submit: false },
		DEPS({ send: recorder() }),
	);
	assert(withSub.data.submit === false, "submit=false echoed in the receipt");
	const sent = DEPS({ send: recorder() });
	await msg.messageAgent(
		{ target: "scout", text: "x", submit: false },
		sent,
	);
	assert(sent.send.calls[0].opts.submit === false, "submit=false reaches send");
	const def = DEPS({ send: recorder() });
	await msg.messageAgent({ target: "scout", text: "x" }, def);
	assert(def.send.calls[0].opts.submit === true, "submit defaults true");

	// send failure propagates
	const broken = await msg.messageAgent(
		{ target: "scout", text: "x" },
		DEPS({
			send: async () => ({
				ok: false,
				error: { code: "VALIDATION_ERROR", message: "cannot encode" },
			}),
		}),
	);
	assert(!broken.ok && broken.error.code === "VALIDATION_ERROR", "send error propagates");
}

console.log("\n[6] `from` identity chain (spawner-declared, never verified)");
{
	assert(
		eq(msg.envelope("a", "b", "hi"), '<agent-message from="a" to="b">\nhi\n</agent-message>'),
		"envelope shape: <agent-message from to> wrapping the text",
	);

	const label = await msg.senderLabel(DEPS({ env: { PI_HERDR_AGENT_LABEL: "lab" } }));
	assert(eq(label, "lab"), "PI_HERDR_AGENT_LABEL wins");

	const name = await msg.senderLabel(DEPS({ env: { PI_HERDR_NAME: "scout-2" } }));
	assert(eq(name, "scout-2"), "PI_HERDR_NAME (what spawn stamps) is next");

	const paneName = await msg.senderLabel(
		DEPS({
			env: { HERDR_PANE_ID: "w1:p2" },
			agentGet: okGet("w1:p2", "pane-named", "idle"),
		}),
	);
	assert(eq(paneName, "pane-named"), "own pane's herdr name via HERDR_PANE_ID");

	const paneId = await msg.senderLabel(
		DEPS({ env: { HERDR_PANE_ID: "w1:p2" }, agentGet: notFound() }),
	);
	assert(eq(paneId, "w1:p2"), "pane id when the lookup fails");

	const session = await msg.senderLabel(DEPS({ env: {} }));
	assert(eq(session, "session"), '"session" when nothing is set (top-level)');
}

console.log("\n[7] Receipt shape + registration");
{
	const r = await msg.messageAgent(
		{ target: "scout", text: "x" },
		DEPS({ agentGet: okGet("w1:p1", "scout", "idle") }),
	);
	assert(
		eq(Object.keys(r.data).sort(), [
			"delivered",
			"delivery",
			"from",
			"state",
			"submit",
			"target",
			"to",
		]),
		"receipt keys for a foreign target: delivered/target/to/from/state/delivery/submit",
	);
	const ours = await msg.messageAgent(
		{ target: "scout", text: "x" },
		DEPS({
			agentGet: okGet("w1:p1", "scout", "idle"),
			registry: registryWith([record()]),
		}),
	);
	assert(ours.data.name === "scout", "receipt names the handle for our spawns");
	assert(r.data.delivered === true, "delivered is literally true");

	const tools = [];
	msg.registerMessageTool({ registerTool: (d) => tools.push(d), on: () => {} });
	assert(
		tools.some((t) => t.name === "herdr_message_agent"),
		"herdr_message_agent registered",
	);
	const tool = tools.find((t) => t.name === "herdr_message_agent");
	assert(
		!!tool.parameters.properties.target &&
			!!tool.parameters.properties.text &&
			!!tool.parameters.properties.submit && eq(tool.parameters.properties.notify.enum, ["wake", "quiet", "none"]),
		"schema: required target+text, optional submit and notify",
	);
	// the description teaches receiving models the envelope tag
	assert(
		tool.description.includes("<agent-message"),
		"description documents the envelope tag (no child-side parsing — the model reads it)",
	);
	assert(
		tool.description.includes("herdr_send_keys"),
		"description carries the option-list caveat",
	);
}

console.log("\n[8] Supervised completion overrides and bounded submissions");
{
	const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const dir = mkdtempSync(join(tmpdir(), "pi-herdr-message-"));
	try {
		const send = recorder();
		const foreign = await msg.messageAgent({ target: "peer", text: "x", notify: "wake" }, DEPS({ send }));
		const unsubmitted = await msg.messageAgent({ target: "peer", text: "x", submit: false, notify: "quiet" }, DEPS({ send }));
		const nonPi = await msg.messageAgent({ target: "scout", text: "x", notify: "none" }, DEPS({ send,
			registry: registryWith([record({ kind: "claude", sessionPath: join(dir, "cc.jsonl") })]),
			agentGet: okGet("w1:p9", "scout", "idle"),
		}));
		assert([foreign, unsubmitted, nonPi].every((r) => !r.ok && r.error.code === "VALIDATION_ERROR") && send.calls.length === 0,
			"unsupported explicit notify (peer/non-Pi/unsubmitted) refuses before sending");
		const r = record({ sessionPath: join(dir, "s.jsonl"), task: { id: "old" }, notify: "wake", delivery: { kind: "done", at: 1 } });
		const deps = DEPS({ registry: registryWith([r]), agentGet: okGet(r.paneId, r.name, "idle") });
		const next = await msg.messageAgent({ target: r.name, text: "next" }, deps);
		assert(next.ok && r.task.id !== "old" && r.notify === undefined && !r.delivery,
			"new submitted task omission inherits config instead of the previous override");
		const activeTask = r.task;
		const answer = await msg.messageAgent({ target: r.name, text: "yes", notify: "quiet" }, {
			...deps, agentGet: okGet(r.paneId, r.name, "blocked"),
		});
		assert(answer.ok && answer.data.delivery === "answer" && r.task === activeTask && r.notify === "quiet",
			"blocked raw answer steers the existing task and can update its completion policy");
		r.delivery = { kind: "done", at: 2 };
		const before = { ...r };
		const failed = await msg.messageAgent({ target: r.name, text: "lost", notify: "none" }, {
			...deps, send: async () => ({ ok: false, error: { code: "TIMEOUT", message: "send failed" } }),
		});
		assert(!failed.ok && r.task === before.task && r.delivery === before.delivery && r.notify === before.notify,
			"failed submission restores task, delivery and notification policy");
		let release;
		const pending = msg.messageAgent({ target: r.name, text: "serial" }, {
			...deps, send: () => new Promise((resolve) => release = resolve),
		});
		await new Promise(setImmediate);
		const concurrent = await msg.messageAgent({ target: r.name, text: "racing" }, deps);
		release({ ok: true, data: true });
		await pending;
		assert(!concurrent.ok && concurrent.error.message.includes("in flight"), "concurrent sends from this parent refuse rather than overwrite task identity");
		// Feature-owned task gates: complete work inside the identity lookup
		// seam, after a yield but before it returns. Pending delivery must block
		// steering; delivered work needs an idle pane for a new task. This keeps
		// task-state coverage without duplicating the blocked-answer delay fixture.
		for (const delivered of [false, true]) {
			const race = record({ sessionPath: join(dir, "race.jsonl"), task: { id: `race-${delivered}` }, notify: "wake" });
			const send = recorder();
			const outcome = await msg.messageAgent({ target: race.name, text: "late steer" }, DEPS({
				registry: registryWith([race]), send, env: { HERDR_PANE_ID: "parent:p1" },
				agentGet: async (target) => {
					if (target !== "parent:p1")
						return { ok: true, data: { paneId: race.paneId, status: "working" } };
					await Promise.resolve();
					writeFileSync(`${race.sessionPath}.exit`, JSON.stringify({ type: "done", taskId: race.task.id, keepOpen: true }));
					if (delivered) race.delivery = { kind: "done", at: 3 };
					return { ok: true, data: { paneId: "parent:p1", name: "parent", status: "working" } };
				},
			}));
			const expectedGate = delivered ? "requires an idle pane" : "awaiting delivery";
			assert(!outcome.ok && outcome.error.code === "VALIDATION_ERROR" && outcome.error.message.includes(expectedGate) &&
				send.calls.length === 0 && race.notify === "wake" && race.task.id === `race-${delivered}` && Boolean(race.delivery) === delivered,
				`task completion ${delivered ? "delivered" : "pending"} during lookup enforces its gate without mutating task or policy`);
		}
	} finally { rmSync(dir, { recursive: true, force: true }); }
}

console.log("\n[9] Registry contract — spawnRecords stays the shared home");
{
	spawnMod.clearSpawnRegistry();
	assert(
		spawnMod.spawnRecords().size === 0,
		"clearSpawnRegistry/spawnRecords exported for engine consumers",
	);
}

console.log(
	`\n${failed === 0 ? "✅ ALL PASS" : "❌ SOME FAILED"} (${passed}/${passed + failed})`,
);
process.exit(failed === 0 ? 0 : 1);
