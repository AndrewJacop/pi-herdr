// Push delivery (v0.6 issue 06): ONE shared poll loop that watches the spawn
// registry and steers terminal events into THIS session — the push carries
// the letter (the child's full final assistant message), no doorbell, no
// summary-then-fetch. Tickets 07 (status projection) and 08/11 (workflows)
// hang off the same loop.
//
// Completion detection is triply redundant (research §3):
//   1. exit sidecar (`<session>.exit`, typed done/error, optional rearm) —
//      the child's own terminal declaration (auto-settle or `agent_done`);
//   2. terminal sentinel — the agent vanished with no sidecar: after a
//      bounded grace, the session JSONL's last assistant message is the
//      delivered letter (typed error when stopReason=error) — a death the
//      sidecar missed still delivers;
//   3. pane disappearance — the same absence path lands on an honest gone
//      note when there is nothing on disk to deliver.
// Transient herdr errors are never absence evidence (the tick is skipped).
//
// Wake governance (the `notifications` setting): `normal` → steer + wake,
// `quiet` → next natural turn (no wake), `none` → no terminal push at all
// (pull-only; results stay in the registry + JSONL). A BLOCKED child always
// wakes regardless of the setting — unless a human took the pane over (no
// mid-conversation pushes from a taken-over pane; the human is right there).
//
// User takeover arrives as the `<session>.takeover` marker written by the
// child extension (human typing that is not the parent's own steer echo):
// the loop sends the quiet `user took over <agent>` note once and holds back
// mid-conversation pushes for that record. A final result still lands —
// declared (`agent_done`) or re-armed (idle re-arm, labeled).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fleetList } from "./herdr.js";
import type { NormalizedAgent, Result } from "./env.js";
import {
	getSettingsPaths,
	loadSettings,
	type HerdrSettings,
} from "./settings.js";
import {
	extractSessionResult,
	minedAssistantError,
	readExitSidecar,
	readTakeoverMarker,
	type ExtractedResult,
	type ReadSidecarResult,
	type ReadTakeoverResult,
} from "./sessionfile.js";
import {
	isSubstrateChild,
	readActivityFile,
	STALL_AFTER_MS,
	type ActivityRead,
} from "./status.js";
import { spawnRecords, type DeliveryKind, type SpawnRecord } from "./spawn.js";

// ---- types -----------------------------------------------------------------

/** One steered message (tests capture these through the injected sink). */
export interface SteeredMessage {
	content: string;
	details: Record<string, unknown>;
	/** true → wake the orchestrator now; false → next natural turn. */
	wake: boolean;
}

/** Injectable seams (offline red-green; defaults hit herdr + disk). */
export interface DeliveryDeps {
	/** The session spawn registry — default: the LIVE spawnRecords(). */
	registry?: () => ReadonlyMap<string, SpawnRecord>;
	/** Effective settings (notifications) — default: live settings read. */
	load?: () => HerdrSettings;
	/** One fleet observation per tick — default: the shared fleetList(). */
	list?: () => Promise<Result<NormalizedAgent[]>>;
	/** Completion-sidecar read — default: readExitSidecar. */
	readSidecar?: (sessionPath: string) => ReadSidecarResult;
	/** Takeover-marker read — default: readTakeoverMarker. */
	readTakeover?: (sessionPath: string) => ReadTakeoverResult;
	/** Session-JSONL extraction — default: extractSessionResult. */
	extract?: (sessionPath: string) => ExtractedResult | null;
	/** The steer sink — default: pi.sendMessage into THIS session. */
	push?: (msg: SteeredMessage) => void;
	now?: () => number;
	/** Bounded grace between first absence and the gone resolution (10s). */
	goneGraceMs?: number;
	/** A pre-fetched fleet observation (shared with the watchdog so one tick
	 * costs one `agent list`). When set, `list` is not called. */
	fleet?: Result<NormalizedAgent[]>;
}

// ---- push composition ---------------------------------------------------------

/** Session-retained pointer appended to pi children's pushes. */
function sessionNote(record: SpawnRecord): string {
	return record.sessionPath
		? ` (session: ${record.sessionPath} — retained for resume)`
		: "";
}

/** The wake flags for a terminal push under the notifications setting. */
export function terminalWake(
	notes: HerdrSettings["notifications"],
): SteeredMessage["wake"] {
	return notes !== "quiet"; // normal → wake; quiet → next turn; none → never reaches a push
}

function doneContent(
	record: SpawnRecord,
	extracted: ExtractedResult | null,
	rearm: boolean,
): string {
	const label = rearm ? "auto-delivered after user steer: " : "";
	const body =
		extracted && extracted.text.trim()
			? extracted.text
			: "(the child finished but its session file holds no assistant message)";
	return `${label}Agent "${record.name}" finished — full final message:\n\n${body}${sessionNote(record)}`;
}

function errorContent(
	record: SpawnRecord,
	errorMessage: string,
	extracted: ExtractedResult | null,
	rearm: boolean,
): string {
	const label = rearm ? "auto-delivered after user steer: " : "";
	const body =
		extracted && extracted.text.trim() ? `\n\nLast message:\n${extracted.text}` : "";
	return `${label}Agent "${record.name}" FAILED: ${errorMessage}${body}${sessionNote(record)}`;
}

function goneContent(record: SpawnRecord): string {
	return `Agent "${record.name}" is gone (no live pane; it died or its pane was closed without completing).${sessionNote(record)}`;
}

// ---- the delivery pass --------------------------------------------------------

/**
 * One pass over the registry: takeover notes, terminal pushes, blocked wakes.
 * Non-blocking — the loop calls it on an interval; tests call it directly and
 * advance their own clock between calls.
 */
export async function deliverOnce(deps: DeliveryDeps = {}): Promise<void> {
	const registry = (deps.registry ?? spawnRecords)();
	if (registry.size === 0) return;
	const records = [...registry.values()];
	const now = deps.now ?? (() => Date.now());
	const push = deps.push ?? (() => {});
	const graceMs = deps.goneGraceMs ?? 10_000;

	// One fleet observation per tick. A FAILED observation is not absence
	// evidence — skip the whole tick rather than risk false gones.
	const fleet = deps.fleet ?? (await (deps.list ?? fleetList)());
	if (!fleet.ok) return;
	const statusByPane = new Map<string, string>();
	for (const a of fleet.data) {
		if (a.paneId && a.agentStatus) statusByPane.set(a.paneId, a.agentStatus);
	}

	for (const record of records) {
		// --- takeover marker → quiet note, once. Sent regardless of the
		// notifications setting (no-wake either way; the orchestrator must
		// learn auto-exit is off).
		if (record.sessionPath && !record.tookNotified) {
			const t = (deps.readTakeover ?? readTakeoverMarker)(record.sessionPath);
			if (t.taken) {
				record.takenOver = true;
				record.tookNotified = true;
				push({
					content: `user took over ${record.name}`,
					details: { name: record.name, kind: "takeover" },
					wake: false,
				});
			}
		}

		if (record.delivery) continue; // terminal already steered — one push per event

		// --- never started (a queued record failed in the drain loop, after
		// the spawn tool had already returned "queued")
		if (record.startError) {
			markTerminal(record, "start-error", now);
			push({
				content: `Agent "${record.name}" never started: ${record.startError}`,
				details: { name: record.name, kind: "start-error" },
				wake: terminalWake(notifications(deps)),
			});
			continue;
		}
		if (!record.paneId) continue; // still queued — nothing to watch yet

		// --- route 1: the typed sidecar (pi children). The child's own
		// terminal declaration wins over anything the fleet says.
		const isPi = record.kind.toLowerCase() === "pi" && Boolean(record.sessionPath);
		if (isPi && record.sessionPath) {
			const sidecar = (deps.readSidecar ?? readExitSidecar)(record.sessionPath);
			if (sidecar.state === "ok") {
				deliverSidecar(record, sidecar.sidecar, deps);
				continue;
			}
		}

		const live = statusByPane.get(record.paneId);
		if (live === undefined) {
			// --- routes 2+3: absence evidence. First sight starts the bounded
			// grace (a dying auto-exit writes its sidecar just before exit and
			// the fleet may drop it first); expiry resolves by best evidence.
			if (record.goneAt === undefined) {
				record.goneAt = now();
				continue;
			}
			if (now() - record.goneAt < graceMs) continue; // still in grace
			if (isPi && record.sessionPath) {
				const extracted = (deps.extract ?? extractSessionResult)(
					record.sessionPath,
				);
				if (extracted) {
					// the sentinel: a sidecar-less death whose last message is
					// still deliverable (typed error when stopReason=error)
					const mined = minedAssistantError(extracted.message);
					markTerminal(record, mined ? "error" : "done", now);
					if (mined) {
						pushTerminal(
							deps,
							{
								content: errorContent(record, mined.errorMessage, extracted, false),
								details: {
									name: record.name,
									kind: "error",
									error: mined,
									message: extracted.message,
									sessionPath: record.sessionPath,
								},
								wake: terminalWake(notifications(deps)),
							},
							notifications(deps),
						);
					} else {
						pushTerminal(
							deps,
							{
								content: doneContent(record, extracted, false),
								details: {
									name: record.name,
									kind: "done",
									result: extracted.text,
									message: extracted.message,
									sessionPath: record.sessionPath,
								},
								wake: terminalWake(notifications(deps)),
							},
							notifications(deps),
						);
					}
					continue;
				}
			}
			// route 3: nothing on disk — an honest gone note (session retained)
			markTerminal(record, "gone", now);
			pushTerminal(
				deps,
				{
					content: goneContent(record),
					details: { name: record.name, kind: "gone" },
					wake: terminalWake(notifications(deps)),
				},
				notifications(deps),
			);
			continue;
		}

		// present again — grace resets
		record.goneAt = undefined;
		record.lastStatus = live;

		// --- blocked always wakes (unless a human has the pane); the wake is
		// per blocked episode, not per tick.
		if (live === "blocked") {
			if (!record.blockedNotified && !record.takenOver) {
				record.blockedNotified = true;
				// always wakes — the notifications setting does not apply
				push({
					content:
						`Agent "${record.name}" is BLOCKED on a question and needs input — ` +
						`answer with herdr_message_agent (raw text) or herdr_send_keys (option lists).`,
					details: { name: record.name, kind: "blocked" },
					wake: true,
				});
			}
			continue;
		}
		record.blockedNotified = false; // fresh episodes re-wake
		// Live idle/done WITHOUT a sidecar is not terminal for pi children
		// (interactive stance sits idle; only the sidecar, the sentinel, or a
		// gone resolution deliver). Non-pi children have no substrate — pull
		// and coarse statuses only (pi-only push ruling).
	}
}

function deliverSidecar(
	record: SpawnRecord,
	sidecar: { type: "done"; rearm?: true } | { type: "error"; errorMessage: string; stopReason: string; rearm?: true },
	deps: DeliveryDeps,
): void {
	const now = deps.now ?? (() => Date.now());
	const notes = notifications(deps);
	const extracted = record.sessionPath
		? (deps.extract ?? extractSessionResult)(record.sessionPath)
		: null;
	const rearm = sidecar.rearm === true;
	if (sidecar.type === "done") {
		markTerminal(record, "done", now);
		pushTerminal(
			deps,
			{
				content: doneContent(record, extracted, rearm),
				details: {
					name: record.name,
					kind: "done",
					...(rearm ? { rearm: true } : {}),
					result: extracted?.text,
					...(extracted ? { message: extracted.message } : {}),
					...(record.sessionPath ? { sessionPath: record.sessionPath } : {}),
				},
				wake: terminalWake(notes),
			},
			notes,
		);
		return;
	}
	markTerminal(record, "error", now);
	pushTerminal(
		deps,
		{
			content: errorContent(record, sidecar.errorMessage, extracted, rearm),
			details: {
				name: record.name,
				kind: "error",
				...(rearm ? { rearm: true } : {}),
				error: { stopReason: sidecar.stopReason, errorMessage: sidecar.errorMessage },
				...(extracted ? { message: extracted.message } : {}),
				...(record.sessionPath ? { sessionPath: record.sessionPath } : {}),
			},
			wake: terminalWake(notes),
		},
		notes,
	);
}

// ---- small helpers ------------------------------------------------------------

function markTerminal(record: SpawnRecord, kind: DeliveryKind, now: () => number): void {
	record.delivery = { kind, at: now() };
}

function notifications(deps: DeliveryDeps): HerdrSettings["notifications"] {
	return (deps.load ?? defaultLoad)().notifications;
}

/**
 * Terminal pushes honor `notifications: none` by NOT steering (pull-only) —
 * but the event is still marked delivered in the registry, so 07 can prune
 * the row and the loop never re-pushes.
 */
function pushTerminal(
	deps: DeliveryDeps,
	msg: SteeredMessage,
	notes: HerdrSettings["notifications"],
): void {
	if (notes === "none") return;
	(deps.push ?? (() => {}))(msg);
}

const defaultLoad = (): HerdrSettings =>
	loadSettings(getSettingsPaths(process.cwd())).effective;

// ---- the watchdog (v0.6 issue 07) ----------------------------------------------

/** Injectable seams for watchdogOnce (offline red-green; defaults hit herdr
 * + disk). */
export interface WatchdogDeps {
	/** The session spawn registry — default: the LIVE spawnRecords(). */
	registry?: () => ReadonlyMap<string, SpawnRecord>;
	/** One fleet observation — default: the shared fleetList(). */
	list?: () => Promise<Result<NormalizedAgent[]>>;
	/** Pre-fetched observation (shared with deliverOnce — one list per tick). */
	fleet?: Result<NormalizedAgent[]>;
	/** Completion-sidecar read — default: readExitSidecar. */
	readSidecar?: (sessionPath: string) => ReadSidecarResult;
	/** Activity-sidecar read — default: readActivityFile (src/status.ts). */
	readActivity?: (activityPath?: string) => ActivityRead;
	/** The steer sink — default: pi.sendMessage into THIS session. */
	push?: (msg: SteeredMessage) => void;
	now?: () => number;
	/** How long a broken-substrate problem must hold before `stalled`.
	 * Default STALL_AFTER_MS (60s, prior art). */
	stallAfterMs?: number;
}

/** First sighting of a broken-substrate problem (idempotent). */
function stampProblem(record: SpawnRecord, now: number): number {
	record.watch ??= {};
	record.watch.problemSince ??= now;
	return record.watch.problemSince;
}

/**
 * One watchdog pass over the registry. Stall rules reference ONLY broken-
 * substrate evidence: a pane vanished without a completion sidecar, a
 * substrate child whose activity snapshot stays missing/invalid while herdr
 * reports it working, or a fleet-level inspection outage that outlasts the
 * threshold. Aged-but-valid `active`/`waiting` snapshots are healthy no
 * matter how old: the state never stalls merely by aging (ticket ruling).
 * The projected stalled STATE stays derived (src/status.ts); this pass only
 * stamps `record.watch` bookkeeping (problem age, ping-once-per-episode) and
 * steers the pings — entry + recovery — AUTONOMOUS agents only. Interactive
 * panes stay widget-only: a steer there burns an orchestrator turn on a
 * no-op.
 */
export async function watchdogOnce(deps: WatchdogDeps = {}): Promise<void> {
	const registry = (deps.registry ?? spawnRecords)();
	if (registry.size === 0) return;
	const now = deps.now ?? (() => Date.now());
	const push = deps.push ?? (() => {});
	const stallAfterMs = deps.stallAfterMs ?? STALL_AFTER_MS;

	const fleet = deps.fleet ?? (await (deps.list ?? fleetList)());

	for (const record of registry.values()) {
		// queued / never-started / delivered records are out of scope
		if (!record.paneId || record.startError || record.delivery) continue;

		const was = record.watch?.stalled ?? false;
		let stalled = false;
		let reason = "";

		if (!fleet.ok) {
			// Inspection unhealthy at fleet level: never absence evidence, but
			// every watchable pane is blind to us — stamp the problem and
			// stall+ping past the threshold; a later healthy tick recovers.
			const heldMs = now() - stampProblem(record, now());
			if (heldMs >= stallAfterMs) {
				stalled = true;
				reason = `herdr fleet inspection unavailable for ${Math.round(heldMs / 1000)}s`;
			}
		} else {
			const sidecarOk =
				isSubstrateChild(record) &&
				record.sessionPath &&
				(deps.readSidecar ?? readExitSidecar)(record.sessionPath).state ===
					"ok";
			const present = fleet.data.some((a) => a.paneId === record.paneId);
			const live = fleet.data.find((a) => a.paneId === record.paneId)
				?.agentStatus;
			let problem = false;

			if (!present && !sidecarOk) {
				stalled = true;
				reason = "the pane vanished without a completion sidecar";
			} else if (
				present &&
				isSubstrateChild(record) &&
				!sidecarOk &&
				live === "working"
			) {
				const read = (deps.readActivity ?? readActivityFile)(
					record.activityPath,
				);
				if (read.state !== "ok") {
					problem = true;
					const heldMs = now() - stampProblem(record, now());
					if (heldMs >= stallAfterMs) {
						stalled = true;
						reason = `no usable activity snapshot for ${Math.round(heldMs / 1000)}s`;
					}
				}
			}
			// healthy presence (or a completion sidecar in hand): clear stamps
			if (!problem && !stalled && record.watch)
				record.watch.problemSince = undefined;
		}

		record.watch ??= {};
		record.watch.stalled = stalled;
		if (stalled === was) continue; // no episode edge — nothing to say
		if (record.stance !== "autonomous") continue; // interactive: widget-only

		if (stalled) {
			push({
				content:
					`Agent "${record.name}" looks STALLED (${reason}). ` +
					`Steer it with herdr_message_agent, or inspect with herdr_get_agent_result.`,
				details: { name: record.name, kind: "stalled", reason },
				wake: true,
			});
		} else {
			push({
				content: `Agent "${record.name}" recovered from a stall — responsive again.`,
				details: { name: record.name, kind: "stall-recovered" },
				wake: true,
			});
		}
	}
}

// ---- the loop -----------------------------------------------------------------

const DELIVERY_INTERVAL_MS = 2_500;

let deliveryTimer: NodeJS.Timeout | null = null;

/**
 * Register the steer sink + start the shared loop (orchestrator side).
 * Idempotent; ticks no-op when the registry is empty. 07/11 attach their own
 * consumers to the same tick later.
 */
export function registerDelivery(pi: ExtensionAPI): void {
	if (deliveryTimer) return;
	const push = (msg: SteeredMessage): void => {
		try {
			pi.sendMessage(
				{
					customType: "herdr-delivery",
					content: msg.content,
					display: true,
					details: msg.details,
				},
				msg.wake
					? { triggerTurn: true, deliverAs: "steer" }
					: { triggerTurn: false, deliverAs: "nextTurn" },
			);
		} catch {
			/* best-effort — delivery must never break the loop */
		}
	};
	const tick = async (): Promise<void> => {
		try {
			// An idle registry costs nothing — no fleet call, no passes.
			if (spawnRecords().size === 0) return;
			// ONE fleet observation per tick, shared by both passes.
			const fleet = await fleetList();
			await deliverOnce({ push, fleet });
			await watchdogOnce({ push, fleet });
		} catch {
			/* best-effort */
		}
	};
	deliveryTimer = setInterval(() => void tick(), DELIVERY_INTERVAL_MS);
	deliveryTimer.unref?.();
}

/** Stop the loop (tests; /reload tears the module down anyway). */
export function stopDeliveryLoop(): void {
	if (deliveryTimer) {
		clearInterval(deliveryTimer);
		deliveryTimer = null;
	}
}
