// Offline tests for push delivery + user takeover + idle re-arm (issue 06).
//
// Sections:
//   [1] sessionfile: sidecar rearm typing, takeover/steer markers, the
//       steer-watermark matcher (human typing vs the parent's own steering)
//   [2] child extension: takeover flag/marker, idle re-arm timer, error-grace
//       suppression under takeover
//   [3] delivery loop: the three detection routes, wake flags, push labels,
//       single-push dedupe, takeover suppression
//
// No live herdr server required: every herdr-facing seam is injected.
//
// Run: node tests/delivery.mjs

import { createJiti } from "jiti";
import {
	existsSync,
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const sf = await jiti.import(join(ROOT, "src/sessionfile.ts"), {
	parent: ROOT,
});

// temp area for real marker files (the helpers use the real fs, like
// readExitSidecar — substrates stay honest by testing against disk)
const tmp = mkdtempSync(join(tmpdir(), "pi-herdr-delivery-"));

// ---------------------------------------------------------------------------
console.log("\n[1] Sidecar rearm + takeover/steer markers");
{
	// rearm typing
	assert(
		sf.parseExitSidecar('{"type":"done"}').sidecar.rearm === undefined,
		"plain done sidecar carries no rearm (back-compat)",
	);
	assert(
		sf.parseExitSidecar('{"type":"done","rearm":true}').sidecar.rearm === true,
		"done + rearm parses",
	);
	const errS = sf.parseExitSidecar(
		'{"type":"error","errorMessage":"overload","stopReason":"error","rearm":true}',
	).sidecar;
	assert(
		errS.rearm === true && errS.errorMessage === "overload",
		"error + rearm parses with the mined message",
	);
	assert(
		sf.parseExitSidecar('{"type":"done","rearm":"yes"}').sidecar.rearm ===
			undefined,
		"non-boolean rearm ignored (tolerant)",
	);
	assert(
		sf.parseExitSidecar('{"type":"done","unknown":{"x":1}}').ok === true,
		"unknown fields tolerated (forward compat)",
	);

	// takeover marker
	const sess = join(tmp, "a.jsonl");
	assert(sf.readTakeoverMarker(sess).taken === false, "no marker = not taken");
	writeFileSync(sf.takeoverPathFor(sess), "{}");
	const t = sf.readTakeoverMarker(sess);
	assert(t.taken === true, "marker present = taken");
	assert(typeof t.at === "number", "marker carries its mtime");

	// steer watermark + matcher
	assert(sf.readSteerWatermark(sess) === null, "no watermark = null");
	sf.writeSteerWatermark(sess, "scan the repo and report\nfailures");
	assert(
		sf.readSteerWatermark(sess)?.startsWith("scan the repo"),
		"watermark round-trips",
	);
	assert(
		sf.inputMatchesSteer("scan the repo and report\nfailures", sf.readSteerWatermark(sess)) ===
			true,
		"exact steer text matches",
	);
	assert(
		sf.inputMatchesSteer("  scan  the repo and report failures \n", sf.readSteerWatermark(sess)) ===
			true,
		"whitespace-insensitive match (chunked/pasted delivery)",
	);
	assert(
		sf.inputMatchesSteer("2", "2") === true,
		"short option-list answer matches its watermark",
	);
	assert(
		sf.inputMatchesSteer("let me just fix this myself", sf.readSteerWatermark(sess)) ===
			false,
		"a human's own words do not match",
	);
	assert(
		sf.inputMatchesSteer(undefined, "anything") === false &&
			sf.inputMatchesSteer("x", null) === false,
		"missing input or watermark never matches",
	);
	sf.clearSteerWatermark(sess);
	assert(
		sf.readSteerWatermark(sess) === null && !existsSync(sf.steerPathFor(sess)),
		"clear consumes the watermark",
	);
	sf.clearSteerWatermark(sess); // second clear is a harmless no-op
	assert(true, "double clear does not throw");
}

// ---------------------------------------------------------------------------
console.log("\n[2] Child extension — takeover + idle re-arm");
{
	const child = await jiti.import(join(ROOT, "src/child.ts"), { parent: ROOT });

	function makePi() {
		const registered = {
			widgets: {},
			tools: [],
			handlers: {},
			sessionName: undefined,
		};
		const mockPi = {
			setSessionName: (n) => (registered.sessionName = n),
			getAllTools: () => [],
			setWidget: (key, lines) => (registered.widgets[key] = lines),
			registerShortcut: () => {},
			registerTool: (t) => registered.tools.push(t),
			on: (ev, h) => (registered.handlers[ev] ??= []).push(h),
		};
		return { mockPi, registered };
	}

	async function childSession(env) {
		const dir = mkdtempSync(join(tmpdir(), "pi-herdr-takeover-"));
		const sess = join(dir, "s.jsonl");
		writeFileSync(sess, "");
		for (const [k, v] of Object.entries(env)) process.env[k] = v;
		const { mockPi, registered } = makePi();
		child.registerChildExtension(mockPi);
		return {
			dir,
			sess,
			registered,
			cleanup() {
				for (const k of Object.keys(env)) delete process.env[k];
				rmSync(dir, { recursive: true, force: true });
			},
		};
	}
	const sidecar = (sess) =>
		existsSync(`${sess}.exit`)
			? JSON.parse(readFileSync(`${sess}.exit`, "utf8"))
			: undefined;
	let shuts = 0;
	async function runTo(registered, stopReason = "stop") {
		await registered.handlers.agent_end[0]({
			type: "agent_end",
			messages: [{ role: "assistant", stopReason }],
		});
		await registered.handlers.agent_settled[0](
			{},
			{ shutdown: () => shuts++ },
		);
	}

	// --- takeover marking: human vs steering echo vs programmatic ---------
	{
		const t = await childSession({
			PI_HERDR_SESSION: "",
		});
		// PI_HERDR_SESSION must be set AFTER makePi snapshots env — handle below
		t.cleanup();
	}
	{
		const dir = mkdtempSync(join(tmpdir(), "pi-herdr-takeover-"));
		const sess = join(dir, "s.jsonl");
		writeFileSync(sess, "");
		process.env.PI_HERDR_SESSION = sess;
		process.env.PI_HERDR_NAME = "scout";
		const { mockPi, registered } = makePi();
		child.registerChildExtension(mockPi);
		try {
			const input = registered.handlers.input[0];

			// the parent's own steering echo: watermark matches → NOT takeover,
			// watermark consumed
			sf.writeSteerWatermark(sess, "scan the repo and report");
			await input({ type: "input", text: "scan the repo and report", source: "interactive" });
			assert(
				sf.readTakeoverMarker(sess).taken === false,
				"the parent's own steering echo is not a takeover",
			);
			assert(
				sf.readSteerWatermark(sess) === null,
				"a matched watermark is consumed",
			);

			// a human types their own words → takeover marker written once
			await input({ type: "input", text: "focus on the parser instead", source: "interactive" });
			assert(
				sf.readTakeoverMarker(sess).taken === true,
				"a human's typing marks the takeover",
			);
			const firstAt = sf.readTakeoverMarker(sess).at;
			await input({ type: "input", text: "more words", source: "interactive" });
			assert(
				sf.readTakeoverMarker(sess).at === firstAt,
				"the marker is written once (not rewritten per keystroke)",
			);

			// programmatic input is never a takeover…
			const dir2 = mkdtempSync(join(tmpdir(), "pi-herdr-takeover2-"));
			const sess2 = join(dir2, "s.jsonl");
			writeFileSync(sess2, "");
			process.env.PI_HERDR_SESSION = sess2;
			const pi2 = makePi();
			child.registerChildExtension(pi2.mockPi);
			await pi2.registered.handlers.input[0]({
				type: "input",
				text: "anything",
				source: "rpc",
			});
			assert(
				sf.readTakeoverMarker(sess2).taken === false,
				"rpc input is programmatic, not a human takeover",
			);
			// …but an input with no source (defensive, older pi) counts human
			await pi2.registered.handlers.input[0]({ type: "input", text: "hello" });
			assert(
				sf.readTakeoverMarker(sess2).taken === true,
				"input with no source field is treated as human (never slam shut)",
				
			);
			rmSync(dir2, { recursive: true, force: true });
			delete process.env.PI_HERDR_SESSION;
		} finally {
			delete process.env.PI_HERDR_SESSION;
			delete process.env.PI_HERDR_NAME;
			rmSync(dir, { recursive: true, force: true });
		}
	}

	// --- idle re-arm: taken-over autonomous child -------------------------
	{
		const t = await childSession({
			PI_HERDR_SESSION: "",
		});
		t.cleanup();
	}
	{
		const dir = mkdtempSync(join(tmpdir(), "pi-herdr-rearm-"));
		const sess = join(dir, "s.jsonl");
		writeFileSync(sess, "");
		process.env.PI_HERDR_SESSION = sess;
		process.env.PI_HERDR_AUTO_EXIT = "1";
		process.env.PI_HERDR_IDLE_REARM_MS = "80";
		process.env.PI_HERDR_ERROR_EXIT_GRACE_MS = "40";
		const { mockPi, registered } = makePi();
		child.registerChildExtension(mockPi);
		try {
			const input = registered.handlers.input[0];
			// human takes over first
			await input({ type: "input", text: "my own words", source: "interactive" });

			// clean settle under takeover: NO immediate exit, no sidecar yet
			shuts = 0;
			await runTo(registered, "stop");
			assert(
				shuts === 0 && sidecar(sess) === undefined,
				"taken-over settle does NOT auto-exit nor write an early sidecar",
			);

			// a keystroke resets the timer: input mid-window, no settle after
			await sleep(30);
			await input({ type: "input", text: "more steering", source: "interactive" });
			await sleep(80);
			assert(
				shuts === 0 && sidecar(sess) === undefined,
				"a keystroke resets the re-arm timer (cancelled until the next settle)",
			);

			// quiet window elapses after the fresh settle → rearm sidecar + exit
			await runTo(registered, "stop");
			await sleep(120);
			const s = sidecar(sess);
			assert(
				shuts === 1 && s && s.type === "done" && s.rearm === true,
				"quiet re-arm window → {type:done, rearm:true} sidecar + pane close",
			);
		} finally {
			for (const k of [
				"PI_HERDR_SESSION",
				"PI_HERDR_AUTO_EXIT",
				"PI_HERDR_IDLE_REARM_MS",
				"PI_HERDR_ERROR_EXIT_GRACE_MS",
			])
				delete process.env[k];
			rmSync(dir, { recursive: true, force: true });
		}
	}

	// --- error settle under takeover: re-arm governs, error-grace suppressed
	{
		const dir = mkdtempSync(join(tmpdir(), "pi-herdr-rearm-err-"));
		const sess = join(dir, "s.jsonl");
		writeFileSync(sess, "");
		process.env.PI_HERDR_SESSION = sess;
		process.env.PI_HERDR_AUTO_EXIT = "1";
		process.env.PI_HERDR_IDLE_REARM_MS = "80";
		process.env.PI_HERDR_ERROR_EXIT_GRACE_MS = "30";
		const { mockPi, registered } = makePi();
		child.registerChildExtension(mockPi);
		try {
			await registered.handlers.input[0]({
				type: "input",
				text: "human here",
				source: "interactive",
			});
			shuts = 0;
			await runTo(registered, "error");
			await sleep(60); // well past the 30ms error-grace
			assert(
				shuts === 0,
				"a pane never slams shut on a human: the 30s error-exit grace is suppressed",
			);
			await sleep(80); // past the 80ms re-arm window
			const s = sidecar(sess);
			assert(
				shuts === 1 && s && s.type === "error" && s.rearm === true,
				"the re-arm window exits with a typed, rearm-labeled error",
			);
		} finally {
			for (const k of [
				"PI_HERDR_SESSION",
				"PI_HERDR_AUTO_EXIT",
				"PI_HERDR_IDLE_REARM_MS",
				"PI_HERDR_ERROR_EXIT_GRACE_MS",
			])
				delete process.env[k];
			rmSync(dir, { recursive: true, force: true });
		}
	}

	// --- interactive stance + takeover: re-arm still applies ---------------
	{
		const dir = mkdtempSync(join(tmpdir(), "pi-herdr-rearm-int-"));
		const sess = join(dir, "s.jsonl");
		writeFileSync(sess, "");
		process.env.PI_HERDR_SESSION = sess;
		process.env.PI_HERDR_AUTO_EXIT = "0";
		process.env.PI_HERDR_IDLE_REARM_MS = "60";
		const { mockPi, registered } = makePi();
		child.registerChildExtension(mockPi);
		try {
			await registered.handlers.input[0]({
				type: "input",
				text: "human here",
				source: "interactive",
			});
			shuts = 0;
			await runTo(registered, "stop");
			await sleep(100);
			const s = sidecar(sess);
			assert(
				shuts === 1 && s && s.type === "done" && s.rearm === true,
				"taken-over INTERACTIVE pane re-arms too (stance-independent)",
			);
		} finally {
			for (const k of ["PI_HERDR_SESSION", "PI_HERDR_AUTO_EXIT", "PI_HERDR_IDLE_REARM_MS"])
				delete process.env[k];
			rmSync(dir, { recursive: true, force: true });
		}
	}

	// --- aborted under takeover: open, no timer ----------------------------
	{
		const dir = mkdtempSync(join(tmpdir(), "pi-herdr-rearm-abort-"));
		const sess = join(dir, "s.jsonl");
		writeFileSync(sess, "");
		process.env.PI_HERDR_SESSION = sess;
		process.env.PI_HERDR_AUTO_EXIT = "1";
		process.env.PI_HERDR_IDLE_REARM_MS = "40";
		const { mockPi, registered } = makePi();
		child.registerChildExtension(mockPi);
		try {
			await registered.handlers.input[0]({
				type: "input",
				text: "human here",
				source: "interactive",
			});
			shuts = 0;
			await runTo(registered, "aborted");
			await sleep(90);
			assert(
				shuts === 0 && sidecar(sess) === undefined,
				"aborted run under takeover stays open with no re-arm timer",
			);
		} finally {
			for (const k of ["PI_HERDR_SESSION", "PI_HERDR_AUTO_EXIT", "PI_HERDR_IDLE_REARM_MS"])
				delete process.env[k];
			rmSync(dir, { recursive: true, force: true });
		}
	}

	// --- untouched behavior: no takeover → the old paths hold --------------
	{
		const dir = mkdtempSync(join(tmpdir(), "pi-herdr-rearm-off-"));
		const sess = join(dir, "s.jsonl");
		writeFileSync(sess, "");
		process.env.PI_HERDR_SESSION = sess;
		process.env.PI_HERDR_AUTO_EXIT = "1";
		process.env.PI_HERDR_IDLE_REARM_MS = "40";
		const { mockPi, registered } = makePi();
		child.registerChildExtension(mockPi);
		try {
			shuts = 0;
			await runTo(registered, "stop");
			assert(
				shuts === 1 && sidecar(sess)?.type === "done" && !sidecar(sess)?.rearm,
				"no takeover: autonomous clean settle still exits immediately (unlabeled)",
			);
		} finally {
			for (const k of ["PI_HERDR_SESSION", "PI_HERDR_AUTO_EXIT", "PI_HERDR_IDLE_REARM_MS"])
				delete process.env[k];
			rmSync(dir, { recursive: true, force: true });
		}
	}
}

// ---------------------------------------------------------------------------
console.log("\n[3] Delivery loop — detection routes + wake flags");
{
	const delivery = await jiti.import(join(ROOT, "src/delivery.ts"), {
		parent: ROOT,
	});

	const rec = (name, over = {}) => ({
		name,
		kind: "pi",
		prompt: "",
		agentArgs: [],
		depth: 1,
		isolated: false,
		spawnedAt: 0,
		submitted: true,
		sawWorking: true,
		stance: "autonomous",
		paneId: `w1:${name}`,
		...over,
	});
	const writeSession = (sess, messages) =>
		writeFileSync(
			sess,
			messages.map((m) => JSON.stringify({ type: "message", message: m })).join("\n") +
				"\n",
		);
	const assistantMsg = (text, extra = {}) => ({
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason: "stop",
		...extra,
	});

	/** Fake world: registry + fleet statuses + fake clock + captured pushes. */
	function world(records, opts = {}) {
		const pushes = [];
		let clock = 1_000_000;
		let fleet = opts.fleet ?? [];
		const registry = new Map(records.map((r) => [r.name, r]));
		const deps = {
			registry: () => registry,
			load: () => ({ notifications: opts.notifications ?? "normal" }),
			list: opts.failList
				? async () => ({ ok: false, error: { code: "TIMEOUT", message: "herdr down" } })
				: async () => ({
						ok: true,
						data: fleet.map((f) => ({
							paneId: f.paneId,
							name: f.name,
							agentStatus: f.status,
						})),
					}),
			push: (m) => pushes.push(m),
			now: () => clock,
			goneGraceMs: opts.goneGraceMs ?? 10_000,
		};
		return {
			deps,
			pushes,
			setFleet: (f) => (fleet = f),
			advance: (ms) => (clock += ms),
			tick: () => delivery.deliverOnce(deps),
		};
	}

	// --- route 1: the typed sidecar --------------------------------------
	{
		const dir = mkdtempSync(join(tmpdir(), "pi-herdr-dlv-"));
		const sess = join(dir, "s.jsonl");
		writeSession(sess, [assistantMsg("The scan found 3 issues. All fixed.")]);
		const r = rec("scout", { sessionPath: sess });
		const w = world([r], { fleet: [{ paneId: r.paneId, status: "working" }] });
		writeFileSync(`${sess}.exit`, JSON.stringify({ type: "done" }));
		await w.tick();
		assert(
			w.pushes.length === 1 &&
				w.pushes[0].content.includes("The scan found 3 issues. All fixed.") &&
				w.pushes[0].content.includes('Agent "scout" finished'),
			"sidecar done → the FULL final message is the push (the letter, not a doorbell)",
		);
		assert(
			w.pushes[0].wake === true,
			"notifications normal → the push wakes (triggerTurn via sink flags)",
		);
		assert(
			w.pushes[0].details.kind === "done" && r.delivery?.kind === "done",
			"terminal event marked delivered in the registry",
		);
		await w.tick();
		assert(
			w.pushes.length === 1,
			"exactly ONE push per terminal event (inline waits + pulls never double it)",
		);
		rmSync(dir, { recursive: true, force: true });
	}
	{
		const dir = mkdtempSync(join(tmpdir(), "pi-herdr-dlv-"));
		const sess = join(dir, "s.jsonl");
		writeSession(sess, [assistantMsg("re-armed result")]);
		const r = rec("scout", { sessionPath: sess });
		const w = world([r]);
		writeFileSync(`${sess}.exit`, JSON.stringify({ type: "done", rearm: true }));
		await w.tick();
		assert(
			w.pushes[0]?.content.startsWith("auto-delivered after user steer: "),
			"rearm sidecar → honestly labeled auto-delivery",
		);
		rmSync(dir, { recursive: true, force: true });
	}
	{
		const dir = mkdtempSync(join(tmpdir(), "pi-herdr-dlv-"));
		const sess = join(dir, "s.jsonl");
		writeSession(sess, [assistantMsg("", { stopReason: "error" })]);
		const r = rec("scout", { sessionPath: sess });
		const w = world([r]);
		writeFileSync(
			`${sess}.exit`,
			JSON.stringify({ type: "error", errorMessage: "provider overloaded", stopReason: "error" }),
		);
		await w.tick();
		assert(
			w.pushes[0]?.content.includes('Agent "scout" FAILED: provider overloaded'),
			"error sidecar → typed failure reaches the parent",
		);
		assert(
			w.pushes[0]?.details.error?.errorMessage === "provider overloaded",
			"error details carry the mined failure",
		);
		rmSync(dir, { recursive: true, force: true });
	}
	// quiet / none wake flags
	{
		const dir = mkdtempSync(join(tmpdir(), "pi-herdr-dlv-"));
		const sess = join(dir, "s.jsonl");
		writeSession(sess, [assistantMsg("quiet delivery")]);
		const r = rec("scout", { sessionPath: sess });
		const w = world([r], { notifications: "quiet" });
		writeFileSync(`${sess}.exit`, JSON.stringify({ type: "done" }));
		await w.tick();
		assert(
			w.pushes.length === 1 && w.pushes[0].wake === false,
			"notifications quiet → delivers on the next natural turn (no wake)",
		);
		rmSync(dir, { recursive: true, force: true });
	}
	{
		const dir = mkdtempSync(join(tmpdir(), "pi-herdr-dlv-"));
		const sess = join(dir, "s.jsonl");
		writeSession(sess, [assistantMsg("silent result")]);
		const r = rec("scout", { sessionPath: sess });
		const w = world([r], { notifications: "none" });
		writeFileSync(`${sess}.exit`, JSON.stringify({ type: "done" }));
		await w.tick();
		assert(
			w.pushes.length === 0 && r.delivery?.kind === "done",
			"notifications none → no completion push at all (pull-only), still marked delivered",
		);
		rmSync(dir, { recursive: true, force: true });
	}

	// --- route 2: the sentinel — a sidecar-less death ---------------------
	{
		const dir = mkdtempSync(join(tmpdir(), "pi-herdr-dlv-"));
		const sess = join(dir, "s.jsonl");
		writeSession(sess, [assistantMsg("died mid-report but this text survived")]);
		const r = rec("scout", { sessionPath: sess });
		const w = world([r]); // fleet: pane absent from tick 1
		await w.tick();
		assert(
			w.pushes.length === 0 && typeof r.goneAt === "number",
			"first absence starts the bounded grace (no false gone on one lost poll)",
		);
		w.advance(100);
		await w.tick();
		assert(w.pushes.length === 0, "still within the grace window — nothing pushed");
		w.advance(11_000);
		await w.tick();
		assert(
			w.pushes.length === 1 &&
				w.pushes[0].content.includes("died mid-report but this text survived"),
			"sentinel: after grace the JSONL's last message IS the delivered letter",
		);
		rmSync(dir, { recursive: true, force: true });
	}
	{
		const dir = mkdtempSync(join(tmpdir(), "pi-herdr-dlv-"));
		const sess = join(dir, "s.jsonl");
		writeSession(sess, [
			assistantMsg("", { stopReason: "error", errorMessage: "rate limited" }),
		]);
		const r = rec("scout", { sessionPath: sess });
		const w = world([r]);
		await w.tick(); // stamps goneAt (grace starts)
		w.advance(11_000);
		await w.tick();
		assert(
			w.pushes[0]?.content.includes("FAILED: rate limited") &&
				w.pushes[0].details.kind === "error",
			"sentinel mines stopReason=error → typed failure, not a mystery",
		);
		rmSync(dir, { recursive: true, force: true });
	}
	// --- route 3: disappearance with nothing on disk -----------------------
	{
		const dir = mkdtempSync(join(tmpdir(), "pi-herdr-dlv-"));
		const sess = join(dir, "s.jsonl");
		writeFileSync(sess, "");
		const r = rec("scout", { sessionPath: sess });
		const w = world([r]);
		await w.tick(); // stamps goneAt (grace starts)
		w.advance(11_000);
		await w.tick();
		assert(
			w.pushes[0]?.content.includes('Agent "scout" is gone') &&
				w.pushes[0].details.kind === "gone" &&
				w.pushes[0].content.includes("retained"),
			"pane vanished with no evidence → honest gone note, session retained",
		);
		rmSync(dir, { recursive: true, force: true });
	}
	// transient herdr errors are not absence evidence
	{
		const r = rec("scout", { sessionPath: join(tmpdir(), "nope.jsonl") });
		const w = world([r], { failList: true });
		w.advance(30_000);
		await w.tick();
		assert(
			w.pushes.length === 0 && r.goneAt === undefined,
			"a failed fleet observation skips the tick — never a false gone",
		);
	}
	// reappear clears the grace
	{
		const r = rec("scout", { sessionPath: join(tmpdir(), "nope2.jsonl") });
		const w = world([r]);
		await w.tick();
		const firstGone = r.goneAt;
		w.setFleet([{ paneId: r.paneId, status: "working" }]);
		w.advance(100);
		await w.tick();
		assert(r.goneAt === undefined, "reappearing clears the absence timer");
		w.setFleet([]);
		w.advance(100);
		await w.tick();
		assert(
			r.goneAt !== undefined && r.goneAt !== firstGone,
			"a second absence starts a FRESH grace window",
		);
		w.advance(9_000);
		await w.tick();
		assert(w.pushes.length === 0, "...and is honored (still in grace)");
	}

	// --- blocked always wakes ----------------------------------------------
	{
		const r = rec("scout", { sessionPath: join(tmpdir(), "nope3.jsonl") });
		const w = world([r], { fleet: [{ paneId: r.paneId, status: "blocked" }] });
		await w.tick();
		assert(
			w.pushes.length === 1 &&
				w.pushes[0].wake === true &&
				w.pushes[0].details.kind === "blocked",
			"blocked always wakes (regardless of the notifications setting)",
		);
		await w.tick();
		assert(
			w.pushes.length === 1,
			"the blocked wake is per episode, not per tick",
			
		);
		// fresh episode re-wakes
		w.setFleet([{ paneId: r.paneId, status: "working" }]);
		await w.tick();
		w.setFleet([{ paneId: r.paneId, status: "blocked" }]);
		await w.tick();
		assert(w.pushes.length === 2, "a NEW blocked episode wakes again");
	}
	{
		for (const notes of ["quiet", "none"]) {
			const r = rec("scout", { sessionPath: join(tmpdir(), "nope4.jsonl") });
			const w = world([r], {
				notifications: notes,
				fleet: [{ paneId: r.paneId, status: "blocked" }],
			});
			await w.tick();
			assert(
				w.pushes.length === 1 && w.pushes[0].wake === true,
				`blocked wakes even under notifications ${notes}`,
			);
		}
	}
	{
		const r = rec("scout", { sessionPath: join(tmpdir(), "nope5.jsonl") });
		r.takenOver = true;
		const w = world([r], { fleet: [{ paneId: r.paneId, status: "blocked" }] });
		await w.tick();
		assert(
			w.pushes.length === 0,
			"a TAKEN-OVER pane never pushes mid-conversation (the human is right there)",
		);
	}

	// --- takeover note (quiet, once) ----------------------------------------
	{
		const dir = mkdtempSync(join(tmpdir(), "pi-herdr-dlv-to-"));
		const sess = join(dir, "s.jsonl");
		writeFileSync(sess, "");
		const r = rec("scout", { sessionPath: sess });
		const w = world([r], { fleet: [{ paneId: r.paneId, status: "working" }] });
		writeFileSync(sf.takeoverPathFor(sess), "{}");
		await w.tick();
		assert(
			w.pushes.length === 1 &&
				w.pushes[0].content === "user took over scout" &&
				w.pushes[0].wake === false,
			"takeover marker → quiet (no-wake) `user took over <agent>` note",
		);
		assert(r.takenOver === true && r.tookNotified === true, "record flags set");
		await w.tick();
		assert(w.pushes.length === 1, "the note is sent once, not per tick");
		rmSync(dir, { recursive: true, force: true });
	}

	// --- never-started / queued / non-pi / live-idle ------------------------
	{
		const failed = rec("fizz", { startError: "boot gate timed out", paneId: undefined });
		const queued = rec("queued-one", { paneId: undefined });
		const w = world([failed, queued]);
		await w.tick();
		assert(
			w.pushes.length === 1 &&
				w.pushes[0].content.includes('Agent "fizz" never started: boot gate timed out'),
			"a queued record that failed its deferred start pushes the typed failure",
		);
		assert(
			queued.delivery === undefined,
			"still-queued records are skipped (nothing to watch yet)",
		);
	}
	{
		const claude = rec("cc", { kind: "claude" });
		const w = world([claude], { fleet: [{ paneId: claude.paneId, status: "done" }] });
		await w.tick();
		assert(
			w.pushes.length === 0 && claude.delivery === undefined,
			"non-pi kinds never completion-push (pi-only push; pull + statuses for them)",
		);
	}
	{
		const dir = mkdtempSync(join(tmpdir(), "pi-herdr-dlv-idle-"));
		const sess = join(dir, "s.jsonl");
		writeSession(sess, [assistantMsg("interim work")]);
		const r = rec("scout", { sessionPath: sess, stance: "interactive" });
		const w = world([r], { fleet: [{ paneId: r.paneId, status: "idle" }] });
		await w.tick();
		await w.tick();
		assert(
			w.pushes.length === 0,
			"live idle WITHOUT a sidecar is not terminal (interactive children sit idle) — pull stays the route",
		);
		rmSync(dir, { recursive: true, force: true });
	}

	// --- registration smoke: sink maps wake → sendMessage flags ------------
	{
		delivery.stopDeliveryLoop();
		const sent = [];
		const mockPi = {
			sendMessage: (msg, opts) => sent.push({ msg, opts }),
		};
		delivery.registerDelivery(mockPi);
		delivery.stopDeliveryLoop();
		delivery.registerDelivery(mockPi); // idempotent restart is fine
		delivery.stopDeliveryLoop();
		assert(sent.length === 0, "the loop ticks no-op on an empty registry");
	}
}

// ---------------------------------------------------------------------------

try {
	rmSync(tmp, { recursive: true, force: true });
} catch {
	/* best-effort */
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
