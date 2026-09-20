// Offline tests for the status projection + watchdog (v0.6 issue 07).
//
// Sections:
//   [1] status.ts: activity sidecar reader, age formatting, the ten-state
//       projection against a fake pane-inspection source
//   [2] child extension: the activity recorder writes the sidecar the poll
//       loop reads (current tool, streaming)
//   [3] watchdog: stall-entry/recovery pings, stance suppression,
//       aged-but-valid active/waiting never stalls
//   [4] get_agent_result: interim statuses speak the projected vocabulary
//   [5] herdr_list_agents: projected states for our records, coarse for
//       adopted panes, queued rows from the parallel-cap queue
//
// No live herdr server required: every herdr-facing seam is injected.
//
// Run: node tests/status.mjs

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

const tmp = mkdtempSync(join(tmpdir(), "pi-herdr-status-"));
const st = await jiti.import(join(ROOT, "src/status.ts"), { parent: ROOT });

// ---------------------------------------------------------------------------
console.log("\n[1] Activity sidecar reader + age format + ten-state projection");
{
	const path = join(tmp, "s.jsonl.activity.json");

	// --- reader ---
	assert(st.readActivityFile(path).state === "missing", "no file = missing");
	writeFileSync(path, "not json");
	assert(st.readActivityFile(path).state === "invalid", "garbage = invalid");
	writeFileSync(path, '{"version":2}');
	assert(st.readActivityFile(path).state === "invalid", "wrong version = invalid");
	writeFileSync(path, '{"version":1,"phase":"warp"}');
	assert(st.readActivityFile(path).state === "invalid", "unknown phase = invalid");

	writeFileSync(
		path,
		JSON.stringify({
			version: 1,
			updatedAt: 1000,
			phase: "active",
			activeSince: 900,
			tool: "bash",
			toolStartedAt: 400,
			streaming: false,
		}),
	);
	const ok = st.readActivityFile(path);
	assert(
		ok.state === "ok" &&
			ok.activity.tool === "bash" &&
			ok.activity.updatedAt === 1000,
		"valid snapshot reads back with tool + freshness",
	);

	// --- age format (worked examples, prior-art shape) ---
	assert(
		st.formatAge(0) === "0s" && st.formatAge(45_000) === "45s",
		"seconds under a minute",
	);
	assert(
		st.formatAge(60_000) === "1m" && st.formatAge(7 * 60_000) === "7m",
		"minutes",
	);
	assert(st.formatAge(2 * 3600_000 + 5 * 60_000) === "2h 5m", "hours + minutes");

	// --- projection: fake pane-inspection inputs ---
	const NOW = 1_000_000;
	function rec(over = {}) {
		return {
			name: "scout",
			kind: "pi",
			stance: "autonomous",
			prompt: "x",
			agentArgs: [],
			depth: 1,
			isolated: false,
			spawnedAt: NOW - 60_000,
			paneId: "w1:p2",
			sessionPath: join(tmp, "s.jsonl"),
			activityPath: join(tmp, "s.jsonl.activity.json"),
			submitted: true,
			sawWorking: true,
			...over,
		};
	}
	const act = (over = {}) => ({
		state: "ok",
		activity: {
			version: 1,
			updatedAt: NOW - 500,
			phase: "active",
			activeSince: NOW - 420_000,
			...over,
		},
	});
	function project(over = {}) {
		const { record, obs } = over;
		return st.projectStatus(record ?? rec(), {
			absent: false,
			unhealthy: false,
			sidecar: false,
			activity: act(),
			...obs,
			now: obs?.now ?? NOW,
		});
	}

	// queued / never-started
	assert(
		project({ record: rec({ paneId: undefined }) }).status === "queued",
		"no pane, no startError = queued",
	);
	assert(
		project({
			record: rec({ paneId: undefined, startError: "boot failed" }),
		}).status === "gone",
		"startError without pane = gone",
	);

	// completion observed, push in flight
	assert(
		project({ obs: { sidecar: true } }).status === "finalizing",
		"completion sidecar, delivery pending = finalizing",
	);
	assert(
		project({ obs: { sidecar: true, absent: true } }).status === "finalizing",
		"sidecar wins over pane absence (the child finished before dying)",
	);

	// delivered + consumed
	assert(
		project({
			record: rec({ delivery: { kind: "done", at: NOW } }),
			obs: { absent: true },
		}).status === "gone",
		"delivered + pane closed = gone (consumed terminal)",
	);
	assert(
		project({
			record: rec({ delivery: { kind: "done", at: NOW } }),
		}).status === "waiting",
		"delivered + pane lingering = waiting",
	);

	// pane vanished without a sidecar
	assert(
		project({ obs: { absent: true } }).status === "stalled",
		"pane vanished without sidecar = stalled (watchdog grace)",
	);

	// blocked (herdr-only signal)
	assert(
		project({ obs: { activity: { state: "missing" }, live: "blocked" } })
			.status === "blocked",
		"herdr blocked = blocked",
	);

	// active with tool detail — the `active · bash 7m` promise
	const withTool = project({
		obs: { activity: act({ tool: "bash", toolStartedAt: NOW - 7 * 60_000 }) },
	});
	assert(
		withTool.status === "active" && withTool.detail === "bash 7m",
		"active · bash 7m — the tool detail is real",
	);

	// active, streaming, no tool
	const streaming = project({
		obs: { activity: act({ streaming: true, activeSince: NOW - 12_000 }) },
	});
	assert(
		streaming.status === "active" && streaming.detail === "streaming 12s",
		"streaming without a tool shows streaming age",
	);

	// activity waiting wins over a stale herdr working (settled child)
	assert(
		project({
			obs: {
				live: "working",
				activity: act({ phase: "waiting", waitingSince: NOW - 5_000 }),
			},
		}).status === "waiting",
		"activity waiting beats herdr working (settled, pane open)",
	);

	// herdr working, no snapshot (pi substrate has not reported yet)
	assert(
		project({ obs: { activity: { state: "missing" }, live: "working" } })
			.status === "active",
		"working + no snapshot yet = coarse active (not stalled at once)",
	);

	// snapshot problem held past the watchdog threshold
	assert(
		project({
			record: rec({ watch: { problemSince: NOW - 61_000 } }),
			obs: { activity: { state: "invalid" }, live: "working" },
		}).status === "stalled",
		"snapshot problem held ≥60s = stalled",
	);

	// non-pi passthrough: coarse running, never any snapshot claim
	assert(
		project({
			record: rec({
				kind: "claude",
				sessionPath: undefined,
				activityPath: undefined,
			}),
			obs: { activity: { state: "missing" }, live: "working" },
		}).status === "running",
		"non-pi panes report coarse running",
	);

	// settled + intentionally open (interactive)
	assert(
		project({
			obs: { activity: { state: "missing" }, live: "idle" },
		}).status === "waiting",
		"settled idle pane = waiting (open and intentionally so)",
	);

	// boot window: prompt not yet in
	assert(
		project({
			record: rec({ submitted: false, sawWorking: false }),
			obs: {
				activity: act({ phase: "starting" }),
				live: "unknown",
			},
		}).status === "starting",
		"boot window (unknown, pre-submit) = starting",
	);

	// aged-but-valid never stalls merely by aging
	assert(
		project({
			obs: {
				activity: act({
					phase: "active",
					activeSince: NOW - 3 * 3600_000,
					updatedAt: NOW - 3 * 3600_000,
				}),
			},
		}).status === "active",
		"3h valid active never becomes stalled by aging",
	);
	assert(
		project({
			obs: {
				activity: act({
					phase: "waiting",
					waitingSince: NOW - 3 * 3600_000,
					updatedAt: NOW - 3 * 3600_000,
				}),
			},
		}).status === "waiting",
		"3h valid waiting never becomes stalled by aging",
	);

	// interrupted is reserved for issue 10 but already derivable — a settled
	// pane with no contradicting active run
	assert(
		project({
			obs: { interrupted: true, live: "idle", activity: { state: "missing" } },
		}).status === "interrupted",
		"interrupted derives from the reserved flag (issue 10 sets it)",
	);

	// transient inspection failure keeps the last-known-live view
	assert(
		project({ obs: { unhealthy: true, activity: { state: "missing" } } })
			.status === "active",
		"transient inspection failure = last-known live (active)",
	);

	// all ten states exist in the vocabulary
	const states = [
		"queued",
		"starting",
		"active",
		"waiting",
		"blocked",
		"interrupted",
		"stalled",
		"running",
		"finalizing",
		"gone",
	];
	for (const s of states)
		assert(st.PROJECTED_STATES.includes(s), `vocabulary has ${s}`);
}

// ---------------------------------------------------------------------------
console.log("\n[2] Child extension — the activity recorder");
{
	const child = await jiti.import(join(ROOT, "src/child.ts"), { parent: ROOT });

	function makePi() {
		const registered = { tools: [], handlers: {}, sessionName: undefined };
		const mockPi = {
			setSessionName: (n) => (registered.sessionName = n),
			getAllTools: () => [],
			setWidget: () => {},
			registerShortcut: () => {},
			registerTool: (t) => registered.tools.push(t),
			on: (ev, h) => (registered.handlers[ev] ??= []).push(h),
		};
		return { mockPi, registered };
	}

	function recorderSession(withActivity = false, env = {}) {
		const dir = mkdtempSync(join(tmpdir(), "pi-herdr-activity-"));
		const sess = join(dir, "s.jsonl");
		writeFileSync(sess, "");
		const activityPath = `${sess}.activity.json`;
		const vars = {
			PI_HERDR_SESSION: sess,
			PI_HERDR_NAME: "scout",
			...(withActivity ? { PI_HERDR_ACTIVITY_FILE: activityPath } : {}),
			...env,
		};
		for (const [k, v] of Object.entries(vars)) process.env[k] = v;
		const { mockPi, registered } = makePi();
		child.registerChildExtension(mockPi);
		const cleanup = () => {
			for (const k of Object.keys(vars)) delete process.env[k];
			rmSync(dir, { recursive: true, force: true });
		};
		return { sess, activityPath, registered, cleanup };
	}
	const readSnap = (p) =>
		existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : undefined;

	// no PI_HERDR_ACTIVITY_FILE → recorder never registers (agent_start is
	// the main extension's own cancel handler; tool events are recorder-only)
	{
		const { registered, cleanup } = recorderSession();
		cleanup();
		assert(
			registered.handlers.session_start.length === 1 &&
				registered.handlers.tool_execution_start === undefined,
			"no activity file env → no recorder handlers registered",
		);
	}

	{
		const t = recorderSession(true);
		const fire = (ev, ...a) => {
			for (const h of t.registered.handlers[ev] ?? []) h(...a);
		};
		// boot: starting
		fire("session_start", { type: "session_start" }, { ui: { setWidget: () => {} } });
			let snap = readSnap(t.activityPath);
			assert(snap?.phase === "starting" && snap.version === 1, "boot writes phase=starting");

			// run starts: active
			fire("agent_start", { type: "agent_start" });
			snap = readSnap(t.activityPath);
			assert(snap?.phase === "active" && typeof snap.activeSince === "number", "run start writes phase=active + activeSince");

			// tool runs: tool name + startedAt
			fire("tool_execution_start", { type: "tool_execution_start", toolCallId: "1", toolName: "bash", args: {} });
			snap = readSnap(t.activityPath);
			assert(snap?.tool === "bash" && typeof snap.toolStartedAt === "number", "tool start records the current tool");

			// tool ends: tool cleared
			fire("tool_execution_end", { type: "tool_execution_end", toolCallId: "1", toolName: "bash", result: {}, isError: false });
			snap = readSnap(t.activityPath);
			assert(snap?.tool === undefined, "tool end clears the tool");

			// streaming (throttled — lands with the trailing write)
			fire("message_update", { type: "message_update", message: {}, assistantMessageEvent: { type: "text_delta" } });
			await new Promise((r) => setTimeout(r, 600));
			snap = readSnap(t.activityPath);
			assert(snap?.streaming === true, "message_update marks streaming (within the write window)");
			fire("tool_execution_start", { type: "tool_execution_start", toolCallId: "2", toolName: "read", args: {} });
			snap = readSnap(t.activityPath);
			assert(snap?.streaming === false && snap?.tool === "read", "a tool run clears streaming");

			// settle: waiting, tool/streaming cleared
			fire("agent_end", { type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] });
			fire("agent_settled", { type: "agent_settled" }, { shutdown: () => {} });
			snap = readSnap(t.activityPath);
			assert(
				snap?.phase === "waiting" &&
					typeof snap.waitingSince === "number" &&
					snap.tool === undefined &&
					snap.streaming === false,
				"settle writes phase=waiting and clears tool/streaming",
			);
			t.cleanup();
		}

	// streaming updates are throttled (≥500ms apart) but never lost — a
	// trailing flush captures the final state
	{
		const t = recorderSession(true);
		const fire = (ev, ...a) => {
			for (const h of t.registered.handlers[ev] ?? []) h(...a);
		};
		fire("session_start", { type: "session_start" }, { ui: { setWidget: () => {} } });
		fire("agent_start", { type: "agent_start" });
		const first = readSnap(t.activityPath);
		for (let i = 0; i < 50; i++)
			fire("message_update", { type: "message_update", message: {}, assistantMessageEvent: { type: "text_delta" } });
		const second = readSnap(t.activityPath);
		assert(
			second.updatedAt === first.updatedAt,
			"rapid streaming updates are throttled to one write per window",
		);
		await new Promise((r) => setTimeout(r, 600));
		const third = readSnap(t.activityPath);
		assert(
			third.updatedAt > first.updatedAt && third.streaming === true,
			"the trailing flush lands within ~500ms with the final state",
		);
		t.cleanup();
	}
}

// ---------------------------------------------------------------------------
console.log("\n[3] Watchdog — stall pings, stance suppression, aged-valid");
{
	const delivery = await jiti.import(join(ROOT, "src/delivery.ts"), { parent: ROOT });
	const NOW = 1_000_000_000;
	const SIDECAR_PATH = join(tmp, "watch-sess.jsonl");
	const ACTIVITY_PATH = `${SIDECAR_PATH}.activity.json`;

	function wrec(over = {}) {
		return {
			name: "scout",
			kind: "pi",
			stance: "autonomous",
			prompt: "x",
			agentArgs: [],
			depth: 1,
			isolated: false,
			spawnedAt: NOW - 120_000,
			paneId: "w1:p3",
			sessionPath: SIDECAR_PATH,
			activityPath: ACTIVITY_PATH,
			submitted: true,
			sawWorking: true,
			...over,
		};
	}
	const healthyActivity = {
		state: "ok",
		activity: { version: 1, updatedAt: NOW - 1_000, phase: "active", activeSince: NOW - 60_000 },
	};

	/** Drive one watchdog tick over a one-record registry. */
	function tick({ record, panes = ["w1:p3"], live = "working", activity = healthyActivity, now = NOW }) {
		const pushes = [];
		const registry = new Map([[record.name, record]]);
		const fleet = {
			ok: true,
			data: panes.map((p) => ({ paneId: p, name: record.name, agentStatus: live })),
		};
		delivery.watchdogOnce({
			registry: () => registry,
			fleet,
			readSidecar: () => ({ state: "missing" }),
			readActivity: () => activity,
			now: () => now,
			push: (m) => pushes.push(m),
		});
		return { record, pushes };
	}

	// stall entry: pane vanished without a completion sidecar
	{
		const { record, pushes } = tick({ record: wrec(), panes: [] });
		assert(record.watch?.stalled === true, "absence without sidecar marks the record stalled");
		assert(pushes.length === 1 && pushes[0].wake === true && /STALLED/.test(pushes[0].content),
			"stall entry pings the orchestrator (wake)");
	}

	// one ping per episode; recovery pings once
	{
		const r = wrec();
		const first = tick({ record: r, panes: [] });
		const second = tick({ record: r, panes: [], now: NOW + 5_000 });
		assert(first.pushes.length === 1 && second.pushes.length === 0,
			"a stalled episode pings once, not per tick");
		const third = tick({ record: r, panes: ["w1:p3"], now: NOW + 10_000 });
		assert(third.pushes.length === 1 && /recovered/.test(third.pushes[0].content) && third.pushes[0].wake === true,
			"recovery pings the orchestrator once");
		assert(r.watch.stalled === false, "recovery clears the stall flag");
	}

	// interactive stance: state tracked, ping suppressed
	{
		const { record, pushes } = tick({ record: wrec({ stance: "interactive" }), panes: [] });
		assert(record.watch?.stalled === true && pushes.length === 0,
			"interactive stall stays widget-only (no steer ping)");
	}

	// aged-but-valid active never stalls
	{
		const aged = {
			state: "ok",
			activity: { version: 1, updatedAt: NOW - 3 * 3600_000, phase: "active", activeSince: NOW - 3 * 3600_000 },
		};
		const { record, pushes } = tick({ record: wrec(), activity: aged, now: NOW + 3 * 3600_000 });
		assert(record.watch?.stalled === false && pushes.length === 0,
			"a 3h valid active snapshot never becomes stalled by aging");
	}

	// snapshot problem: first tick stamps, ping only past the threshold
	{
		const r = wrec();
		const first = tick({ record: r, activity: { state: "invalid" } });
		assert(first.pushes.length === 0 && r.watch?.problemSince === NOW,
			"a broken snapshot is stamped, not instantly stalled");
		const second = tick({ record: r, activity: { state: "invalid" }, now: NOW + 61_000 });
		assert(second.pushes.length === 1 && r.watch.stalled === true,
			"a snapshot problem held ≥60s stalls + pings");
		const third = tick({ record: r, activity: healthyActivity, now: NOW + 62_000 });
		assert(third.pushes.length === 1 && r.watch.stalled === false && r.watch.problemSince === undefined,
			"snapshot recovery clears the problem and pings");
	}

	// fleet-level inspection outage: stamped on first failure, stalls+pings
	// past the threshold, recovers when a healthy observation returns
	{
		const r = wrec();
		const pushes = [];
		const drive = (fleetOk, t) => {
			delivery.watchdogOnce({
				registry: () => new Map([[r.name, r]]),
				fleet: fleetOk
					? { ok: true, data: [{ paneId: r.paneId, name: r.name, agentStatus: "working" }] }
					: { ok: false, error: { code: "VALIDATION_ERROR", message: "herdr down" } },
				readSidecar: () => ({ state: "missing" }),
				readActivity: () => healthyActivity,
				now: () => t,
				push: (m) => pushes.push(m),
			});
		};
		drive(false, NOW);
		assert(pushes.length === 0 && r.watch?.problemSince === NOW,
			"a fleet outage is stamped, not instantly stalled");
		drive(false, NOW + 61_000);
		assert(pushes.length === 1 && r.watch.stalled === true && /unavailable/.test(pushes[0].content),
			"an outage held ≥60s stalls + pings (unhealthy inspection)");
		drive(true, NOW + 62_000);
		assert(pushes.length === 2 && r.watch.stalled === false,
			"a healthy fleet observation recovers the outage stall");
	}

	// completion sidecar present + pane absent → finalizing's business, not a stall
	{
		const record = wrec();
		const pushes = [];
		const registry = new Map([[record.name, record]]);
		delivery.watchdogOnce({
			registry: () => registry,
			fleet: { ok: true, data: [] },
			readSidecar: () => ({ state: "ok", sidecar: { type: "done" } }),
			readActivity: () => healthyActivity,
			now: () => NOW,
			push: (m) => pushes.push(m),
		});
		assert(record.watch?.stalled === false && pushes.length === 0,
			"sidecar + absent pane is completion, not a stall");
	}

	// delivery-consumed records are skipped
	{
		const { record, pushes } = tick({ record: wrec({ delivery: { kind: "done", at: NOW } }), panes: [] });
		assert(pushes.length === 0 && record.watch === undefined,
			"delivered records leave the watchdog's scope");
	}
}

// ---------------------------------------------------------------------------
console.log("\n[4] get_agent_result — interim statuses speak the projected vocabulary");
{
	const resultMod = await jiti.import(join(ROOT, "src/tools/result.ts"), { parent: ROOT });
	const NOW = 2_000_000_000;
	const SESS = join(tmp, "r4.jsonl");
	const ACT = `${SESS}.activity.json`;

	function rrec(over = {}) {
		return {
			name: "scout",
			kind: "pi",
			stance: "autonomous",
			prompt: "x",
			agentArgs: [],
			depth: 1,
			isolated: false,
			spawnedAt: NOW - 60_000,
			paneId: "w1:p4",
			sessionPath: SESS,
			activityPath: ACT,
			submitted: true,
			sawWorking: true,
			...over,
		};
	}
	function deps(over = {}) {
		return {
			registry: () => new Map([["scout", rrec(over.record ?? {})]]),
			status: over.status ?? (async () => ({ ok: true, data: "working" })),
			extract: over.extract ?? (() => null),
			readSidecar: over.readSidecar ?? (() => ({ state: "missing" })),
				readActivity:
					over.readActivity ??
					((path) =>
						path
							? {
									state: "ok",
									activity: {
										version: 1,
										updatedAt: NOW - 500,
										phase: "active",
										activeSince: NOW - 420_000,
										tool: "bash",
										toolStartedAt: NOW - 7 * 60_000,
									},
								}
							: { state: "missing" }),
			now: () => NOW,
			sleep: async () => {},
		};
	}

	// working + valid activity → active with the tool detail
	{
		const r = await resultMod.getAgentResult({ target: "scout" }, deps());
		assert(r.ok && r.data.status === "active" && r.data.detail === "bash 7m",
			"mid-flight pi child reports active · bash 7m");
		assert(r.data.interim === true, "active view stays interim");
	}

	// non-pi children have no snapshots → coarse running
	{
		const r = await resultMod.getAgentResult(
			{ target: "scout" },
			deps({ record: { kind: "claude", sessionPath: undefined, activityPath: undefined } }),
		);
		assert(r.ok && r.data.status === "running", "non-pi panes report coarse running");
	}

	// pre-submit idle → starting
	{
		const r = await resultMod.getAgentResult(
			{ target: "scout" },
			deps({
				record: { submitted: false, sawWorking: false },
				status: async () => ({ ok: true, data: "idle" }),
			}),
		);
		assert(r.ok && r.data.status === "starting", "boot-window idle reports starting (not idle)");
	}

	// transient inspection failure → last-known live, honestly interim
	{
		const r = await resultMod.getAgentResult(
			{ target: "scout" },
			deps({ status: async () => ({ ok: false, error: { code: "VALIDATION_ERROR", message: "boom" } }) }),
		);
		assert(r.ok && r.data.status === "active" && /unavailable/.test(r.data.note ?? ""),
			"transient status failure keeps the last-known-live view");
	}

	// watchdog-aged substrate problem through the pull tool → stalled (not
	// a phantom gone)
	{
		const r = await resultMod.getAgentResult(
			{ target: "scout" },
			deps({
				record: { watch: { problemSince: NOW - 61_000 } },
				status: async () => ({ ok: false, error: { code: "VALIDATION_ERROR", message: "boom" } }),
			}),
		);
		assert(r.ok && r.data.status === "stalled",
			"unhealthy inspection past the threshold reports stalled honestly");
	}

	// gone still carries last-known metadata (v0.5-10 ruling, regression guard)
	{
		const r = await resultMod.getAgentResult(
			{ target: "scout" },
			deps({
				status: async () => ({
					ok: false,
					error: { code: "NOT_FOUND", message: "pane gone", details: { code: "agent_not_found" } },
				}),
			}),
		);
		assert(
			r.ok && r.data.status === "gone" && r.data.lastKnown?.name === "scout" &&
				typeof r.data.lastKnown?.sessionPath === "string",
			"gone answers with last-known registry metadata",
		);
	}

	// autonomous child settled on a failed last attempt: stays non-terminal
	// with the typed payload (the child may still retry)
	{
		const r = await resultMod.getAgentResult(
			{ target: "scout" },
			deps({
				status: async () => ({ ok: true, data: "idle" }),
				extract: () => ({
					text: "attempt failed",
					message: { role: "assistant", stopReason: "error", errorMessage: "overloaded" },
				}),
			}),
		);
		assert(
			r.ok && r.data.status === "active" && r.data.error?.stopReason === "error" &&
				/retry/.test(r.data.note ?? ""),
			"failed-attempt interim stays non-terminal with the typed payload",
		);
	}

	// adopted pane (not ours) → pane-tail fallback reports running
	{
		const r = await resultMod.getAgentResult(
			{ target: "w1:p9" },
			{
				registry: () => new Map(),
				readTail: async () => ({ ok: true, data: { text: "tail text", truncated: false } }),
			},
		);
		assert(
			r.ok && r.data.status === "running" && r.data.source === "pane-tail" && r.data.adopted === true,
			"adopted panes report coarse running via the tail fallback",
		);
	}
}

// ---------------------------------------------------------------------------
console.log("\n[5] herdr_list_agents — projected rows, queued rows, consumed rows");
{
	const orch = await jiti.import(join(ROOT, "src/tools/orchestration.ts"), { parent: ROOT });
	const NOW = 3_000_000_000;
	const SESS5 = join(tmp, "r5.jsonl");

	function lrec(over = {}) {
		return {
			name: "scout",
			kind: "pi",
			stance: "autonomous",
			prompt: "x",
			agentArgs: [],
			depth: 1,
			isolated: false,
			spawnedAt: NOW - 60_000,
			paneId: "w1:p5",
			sessionPath: SESS5,
			activityPath: `${SESS5}.activity.json`,
			submitted: true,
			sawWorking: true,
			...over,
		};
	}
	function ldeps({ records = [], fleet = [], over = {} } = {}) {
		return {
			registry: () => new Map(records.map((r) => [r.name, r])),
			list: async () => ({ ok: true, data: fleet }),
			readSidecar: () => ({ state: "missing" }),
			readActivity: (path) =>
				path
					? {
							state: "ok",
							activity: {
								version: 1,
								updatedAt: NOW - 500,
								phase: "active",
								activeSince: NOW - 420_000,
								tool: "bash",
								toolStartedAt: NOW - 7 * 60_000,
							},
						}
						: { state: "missing" },
			now: () => NOW,
			...over,
		};
	}

	// ours: projected `active · bash 7m`; adopted: coarse
	{
		const r = await orch.listAgentsView(
			ldeps({
				records: [lrec()],
				fleet: [
					{ paneId: "w1:p5", name: "herdr/scout", agentStatus: "working", agent: "pi" },
					{ paneId: "w1:p9", name: "someone-else", agentStatus: "working", agent: "codex" },
				],
			}),
		);
		assert(r.ok, "listAgentsView succeeds");
		const ours = r.data.rows.find((row) => row.paneId === "w1:p5");
		assert(
			ours?.projected === true && ours.state === "active · bash 7m",
			"our pi row reports `active · bash 7m`",
		);
		const adopted = r.data.rows.find((row) => row.paneId === "w1:p9");
		assert(
			adopted?.projected === false && adopted.state === "working",
			"adopted panes keep their coarse status",
		);
	}

	// queued record: a row without a pane
	{
		const r = await orch.listAgentsView(
			ldeps({ records: [lrec({ paneId: undefined })], fleet: [] }),
		);
		const row = r.data.rows.find((row) => row.name === "scout");
		assert(row?.state === "queued", "over-cap records report queued from the registry");
	}

	// vanished pane, undelivered, no sidecar → honest stalled row
	{
		const r = await orch.listAgentsView(
			ldeps({ records: [lrec()], fleet: [] }),
		);
		const row = r.data.rows.find((row) => row.name === "scout");
		assert(row?.state === "stalled", "absent pane without sidecar shows stalled");
	}

	// vanished pane WITH completion sidecar → finalizing (sidecar wins over
	// absence in the registry-only loop too — no drift from the live loop)
	{
		const r = await orch.listAgentsView(
			ldeps({
				records: [lrec()],
				fleet: [],
				over: { readSidecar: () => ({ state: "ok", sidecar: { type: "done" } }) },
			}),
		);
		const row = r.data.rows.find((row) => row.name === "scout");
		assert(row?.state === "finalizing", "absent pane with sidecar shows finalizing (not stalled)");
	}

	// delivered records leave the table
	{
		const r = await orch.listAgentsView(
			ldeps({ records: [lrec({ delivery: { kind: "done", at: NOW } })], fleet: [] }),
		);
		assert(
			r.data.rows.length === 0,
			"delivered (consumed) rows leave the fleet table",
		);
	}

	// completion sidecar + fleet lag → finalizing
	{
		const r = await orch.listAgentsView(
			ldeps({
				records: [lrec()],
				fleet: [{ paneId: "w1:p5", name: "herdr/scout", agentStatus: "working", agent: "pi" }],
				over: { readSidecar: () => ({ state: "ok", sidecar: { type: "done" } }) },
			}),
		);
		const row = r.data.rows.find((row) => row.name === "scout");
		assert(row?.state === "finalizing", "sidecar present (push in flight) shows finalizing");
	}
}

console.log(`\n[5] done: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
