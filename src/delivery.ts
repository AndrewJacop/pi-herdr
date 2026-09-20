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
import { herdr } from "./herdr.js";
import { normalizeAgent, type Result } from "./env.js";
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
	/** One fleet observation per tick — default: `herdr agent list`. */
	list?: () => Promise<
		Result<{ paneId?: string; name?: string; agentStatus?: string }[]>
	>;
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
	const fleet = await (deps.list ?? defaultList)();
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

const defaultList = async (): Promise<
	Result<{ paneId?: string; name?: string; agentStatus?: string }[]>
> => {
	const r = await herdr<{ agents?: unknown[] }>(["agent", "list"], {
		timeoutMs: 10_000,
	});
	if (!r.ok) return r;
	return { ok: true, data: (r.data?.agents ?? []).map(normalizeAgent) };
};

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
			await deliverOnce({ push });
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
