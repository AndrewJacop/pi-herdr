// The status projection (v0.6 issue 07): ten honest states *derived, never
// stored* — queued | starting | active | waiting | blocked | interrupted |
// stalled | running | finalizing | gone — from three sources:
//
//   1. herdr pane inspection (coarse authority: process present?
//      idle/working/blocked?) — the caller observes it and passes `live`/
//      `absent`/`unhealthy`;
//   2. child activity snapshots — the injected child extension (04) writes
//      the activity sidecar (`<session>.activity.json`: current tool,
//      streaming); this is what makes `active · bash 7m` real;
//   3. the watchdog (delivery.ts): flags `stalled` when a pane vanished
//      without a completion sidecar or a substrate snapshot stays broken —
//      on stall-entry and stall-recovery the orchestrator gets a steer ping
//      (autonomous stance; interactive stays widget-only).
//
// Honesty mapping from the old coarse vocabulary: `working` → `active`/
// `running`; `idle` → `waiting` (settled, pane open and intentionally so);
// `done` → `finalizing` (completion observed, push in flight) → delivered
// (the registry `delivery` mark consumes the row). `running` is the coarse
// fallback for panes without snapshots (non-pi passthrough). Aged-but-valid
// `active`/`waiting` NEVER becomes `stalled` merely by aging — stall rules
// reference only broken-substrate evidence, never the age of a healthy
// state. `interrupted` is reserved for issue 10 (vacuously derivable via
// the obs flag until then). Decided by wayfinder/tickets/03-status-
// projection.md; prior art: research/richardh-prior-art.md §4.

import { readFileSync } from "node:fs";

/** The ten-state projected vocabulary (order = the ticket's table). */
export const PROJECTED_STATES = [
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
] as const;

export type ProjectedStatus = (typeof PROJECTED_STATES)[number];

/** How long a broken-substrate problem must hold before the watchdog calls
 * it `stalled` (prior art's SNAPSHOT_STALLED_AFTER_MS). */
export const STALL_AFTER_MS = 60_000;

// ---- activity snapshots --------------------------------------------------------

/** What the injected child extension reports about itself. The parent only
 * ever reads this file — the child is its sole writer. */
export interface ActivitySnapshot {
	version: 1;
	updatedAt: number;
	phase: "starting" | "active" | "waiting";
	/** When the current run began (phase active). */
	activeSince?: number;
	/** When the child settled (phase waiting). */
	waitingSince?: number;
	/** Currently-executing tool (`active · bash 7m`). */
	tool?: string;
	toolStartedAt?: number;
	/** Assistant message streaming (no tool running). */
	streaming?: boolean;
}

export type ActivityRead =
	| { state: "ok"; activity: ActivitySnapshot }
	| { state: "missing" }
	| { state: "invalid"; error?: string };

const ACTIVITY_PHASES = new Set(["starting", "active", "waiting"]);

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

function isActivityPhase(v: unknown): v is ActivitySnapshot["phase"] {
	return typeof v === "string" && ACTIVITY_PHASES.has(v);
}

/** Read + shape-check an activity sidecar. Missing file, unparseable JSON,
 * wrong version, or an unknown phase are all honest `invalid`/`missing`
 * answers — never guesses. */
export function readActivityFile(path: string | undefined): ActivityRead {
	if (!path) return { state: "missing" };
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return { state: "missing" };
	}
	try {
		const a: unknown = JSON.parse(raw);
		if (
			!isRecord(a) ||
			a.version !== 1 ||
			typeof a.updatedAt !== "number" ||
			!isActivityPhase(a.phase)
		) {
			return { state: "invalid" };
		}
		// Shape-checked field by field above; optional fields copied explicitly
		// so no unchecked cast is needed.
		const snapshot: ActivitySnapshot = {
			version: 1,
			updatedAt: a.updatedAt,
			phase: a.phase,
		};
		if (typeof a.activeSince === "number") snapshot.activeSince = a.activeSince;
		if (typeof a.waitingSince === "number") snapshot.waitingSince = a.waitingSince;
		if (typeof a.tool === "string") snapshot.tool = a.tool;
		if (typeof a.toolStartedAt === "number") snapshot.toolStartedAt = a.toolStartedAt;
		if (typeof a.streaming === "boolean") snapshot.streaming = a.streaming;
		return { state: "ok", activity: snapshot };
	} catch (e) {
		return {
			state: "invalid",
			error: e instanceof Error ? e.message : String(e),
		};
	}
}

/** `45s` / `7m` / `2h 5m` — the prior art's elapsed shape (worked examples
 * pinned in tests/status.mjs). */
export function formatAge(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	if (hours > 0) return `${hours}h ${minutes}m`;
	return `${minutes}m`;
}

/** The `bash 7m` / `streaming 12s` half of `active · bash 7m` (undefined =
 * plain active). Tool detail preferred over streaming; age since the tool
 * or run began. */
export function activeDetail(
	activity: ActivitySnapshot,
	now: number,
): string | undefined {
	if (activity.tool) {
		const since = activity.toolStartedAt ?? activity.activeSince;
		return `${activity.tool}${since ? ` ${formatAge(now - since)}` : ""}`;
	}
	if (activity.streaming && activity.activeSince)
		return `streaming ${formatAge(now - activity.activeSince)}`;
	return undefined;
}

// ---- the projection --------------------------------------------------------

/** Everything the projection needs beyond the registry record: one observed
 * pane-inspection fact set + the two sidecar reads. Pure input — offline
 * tests fake all of it. */
export interface ProjectionObs {
	/** herdr's coarse agent_status (idle/working/blocked/done/unknown) when
	 * the pane is present in the fleet. */
	live?: string;
	/** The pane is absent from the fleet (NOT_FOUND / not listed). */
	absent: boolean;
	/** The inspection itself failed transiently (pane status unavailable) —
	 * never absence evidence; keep the last-known-live view. */
	unhealthy: boolean;
	/** Completion sidecar ok (done or error) — the child's own terminal
	 * declaration, delivered or not. */
	sidecar: boolean;
	activity: ActivityRead;
	/** Clock — injected so offline tests advance time freely. */
	now: number;
}

export interface Projection {
	status: ProjectedStatus;
	/** e.g. `bash 7m` — shown as `active · bash 7m`. */
	detail?: string;
}

/** Minimal record shape the projection reads (structural subset of
 * SpawnRecord so offline tests don't need the full engine). */
export interface ProjectableRecord {
	paneId?: string;
	startError?: string;
	kind: string;
	sessionPath?: string;
	activityPath?: string;
	delivery?: { kind: string; at: number };
	/** Turn cancelled (issue 10): when the parent sent Escape. Drives the
	 * projected `interrupted` state — immediate, ahead of herdr's own view —
	 * and the stale-snapshot discard window; cleared by new work (a message
	 * send, or self-corrected by a fresh phase-active snapshot). */
	interruptedAt?: number;
	submitted: boolean;
	sawWorking: boolean;
	/** Watchdog bookkeeping: first sighting of a broken-substrate problem. */
	watch?: { problemSince?: number };
}

/** Whether a record is a substrate child (pi on a parent-owned session
 * file): the kind that writes activity snapshots and completion sidecars.
 * One home for the check the projection, the result tool, the watchdog, and
 * the fleet view all share — change the substrate definition HERE only. */
export function isSubstrateChild(record: {
	kind: string;
	sessionPath?: string;
}): boolean {
	return record.kind.toLowerCase() === "pi" && Boolean(record.sessionPath);
}

/**
 * The ten-state derivation. Precedence (each rule names its source):
 *
 *   1. startError → gone                          (registry)
 *   2. no pane → queued                           (registry / cap queue)
 *   3. delivery consumed → pane? waiting : gone   (registry; terminal row)
 *   4. completion sidecar → finalizing            (sidecar; push in flight)
 *   5. pane absent, no sidecar → stalled          (watchdog: a sidecar-less
 *      death is already a stall; the delivery pass's bounded grace resolves
 *      the terminal answer afterwards)
 *   6. herdr blocked → blocked                    (inspection)
 *   7. turn cancelled (interruptedAt set, pane open, no fresh active
 *      run) → interrupted — IMMEDIATELY, ahead of herdr's own view; the
 *      flag is the parent's Escape receipt (issue 10). A snapshot written
 *      before the escape is discarded (a lagging `bash 7m` cannot
 *      overwrite the interrupt); the child's own post-abort settle write
 *      (fresh `waiting`) holds the state; new work (fresh `active`, or
 *      the flag cleared at message-send time) ends it.
 *   8. inspection unhealthy → stalled past the
 *      threshold, else last-known-live            (inspection + watchdog)
 *   9. herdr working → activity phase (active+detail / waiting), coarse
 *      active until a substrate problem ages past the threshold, or plain
 *      `running` for snapshot-less (non-pi) panes
 *  10. settled (idle/done/unknown): fresher-than-herdr activity active
 *      wins; pre-submit → starting; else waiting
 */
export function projectStatus(
	record: ProjectableRecord,
	obs: ProjectionObs,
): Projection {
	const now = obs.now;
	const isPi = isSubstrateChild(record);
	// Interrupt window (issue 10): while interruptedAt is set, snapshots
	// written before the escape are discarded (stale pre-interrupt readings
	// never overwrite the interrupt), and a fresh phase-ACTIVE snapshot is
	// new-work evidence that self-corrects the state without waiting for a
	// registry write. The child's own post-abort settle write (fresh
	// `waiting`) is NOT new work — the interrupted state holds.
	const interruptedAt = record.interruptedAt;
	const raw = obs.activity;
	// While a turn-cancel is in effect (issue 10), snapshots written before
	// the escape are discarded (a lagging pre-interrupt reading cannot
	// overwrite the interrupt); a fresh phase-ACTIVE snapshot is new-work
	// evidence that self-corrects the state. The child's own post-abort
	// settle write (fresh `waiting`) is NOT new work — the state holds.
	const discarded =
		raw.state === "ok" &&
		interruptedAt !== undefined &&
		raw.activity.updatedAt <= interruptedAt;
	const activityRead: ActivityRead = discarded ? { state: "missing" } : raw;
	const freshActive =
		raw.state === "ok" && !discarded && raw.activity.phase === "active";
	const interrupted = interruptedAt !== undefined && !freshActive;
	const activityOk = activityRead.state === "ok";
	const snapshot = activityOk ? activityRead.activity : undefined;
	const phase = snapshot?.phase;

	if (record.startError) return { status: "gone" };
	if (!record.paneId) return { status: "queued" };

	if (record.delivery)
		return obs.absent ? { status: "gone" } : { status: "waiting" };

	// The child's own terminal declaration: completion observed, push in
	// flight. Wins over pane presence/absence alike (an auto-exited child is
	// already gone from the fleet when its sidecar lands).
	if (obs.sidecar) return { status: "finalizing" };

	if (obs.absent) return { status: "stalled" };

	if (obs.live === "blocked") return { status: "blocked" };

	// Turn cancelled (issue 10): the pane is still open and the escape is
	// the parent's declared fact — wins over herdr's own view (which may
	// still say `working` until the child processes the interrupt) and over
	// the unhealthy last-known-live fallback.
	if (interrupted) return { status: "interrupted" };

	if (obs.unhealthy) {
		const problemSince = record.watch?.problemSince;
		if (problemSince && now - problemSince >= STALL_AFTER_MS)
			return { status: "stalled" };
		return record.submitted || record.sawWorking
			? { status: "active" }
			: { status: "starting" };
	}

	if (obs.live === "working") {
		if (snapshot) {
			if (phase === "active")
				return {
					status: "active",
					detail: activeDetail(snapshot, now),
				};
			if (phase === "waiting") return { status: "waiting" };
			return { status: "starting" }; // activity starting (boot/settling)
		}
		if (isPi) {
			// substrate child with no/broken snapshot: coarse active until the
			// watchdog's problem bookkeeping ages past the threshold.
			const problemSince = record.watch?.problemSince;
			if (problemSince && now - problemSince >= STALL_AFTER_MS)
				return { status: "stalled" };
			return { status: "active" };
		}
		return { status: "running" }; // coarse fallback: non-pi passthrough
	}

	// settled: idle / done / unknown(boot window)
	if (!record.submitted && !record.sawWorking) return { status: "starting" };
	if (snapshot && phase === "active")
		return {
			status: "active",
			detail: activeDetail(snapshot, now),
		};
	return { status: "waiting" };
}
