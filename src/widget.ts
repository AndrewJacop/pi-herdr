// The fleet widget (v0.6 issue 11): the orchestrator's ambient view of the
// fleet — one row per in-flight agent — rendered above the editor.
//
//   ╭─ Subagents ────────────── 1 active · 1 open ─╮
//   │ 00:23  scout-auth       active · bash 7m  7m │
//   │ 00:45  scout-db               waiting       2m │
//   ╰───────────────────────────────────────────────╯
//    ⚠ scout-db BLOCKED 2m "Schema A (wide) or B (tall)?"
//
// Decided by wayfinder/tickets/07-widget.md (layout: research §8):
//   - elapsed = process time (`MM:SS`), FREEZING at `finalizing` — the push
//     is in flight, the process is done counting;
//   - `state · current-tool` from the activity snapshots (07);
//   - state age on the right (snapshot `activeSince`/`waitingSince` when
//     present, else a first-seen cache keyed by state episode);
//   - header counts active ({active, starting, running, blocked}) vs open
//     (the rest still tracked); AMBER BORDER when active = 0 — the "your
//     fleet is idle, look up" signal;
//   - rows LEAVE ON DELIVERY (the delivery mark also covers suppression
//     under `notifications: none`) — in-flight work only, not a morgue;
//   - blocked rows additionally render the callout beneath the table with
//     the question preview (the child's last assistant message) — blocked
//     stays the widget's one loud alarm;
//   - READ-ONLY: no affordances, ever — "go look" = focus the pane.
//
// Data plumbing: ONE poll loop, many consumers — the tick in delivery.ts
// (which feeds push delivery + the watchdog) hands this module the same
// fleet observation; no separate polling tier.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	extractSessionResult,
	readExitSidecar,
	type ExtractedResult,
	type ReadSidecarResult,
} from "./sessionfile.js";
import { spawnRecords, type SpawnRecord } from "./spawn.js";
import {
	formatAge,
	isSubstrateChild,
	projectStatus,
	readActivityFile,
	type ActivityRead,
	type ProjectableRecord,
	type Projection,
} from "./status.js";
import type { NormalizedAgent, Result } from "./env.js";

// ---- the model ---------------------------------------------------------------

/** States that count toward the header's ACTIVE side (ticket ruling). */
const ACTIVE_STATES = new Set(["active", "starting", "running", "blocked"]);

/** One projected row (shape-checked for the renderer). */
export interface WidgetRow {
	name: string;
	status: string;
	detail?: string;
	/** Process elapsed at render time (frozen at `finalizing`). */
	elapsedMs: number;
	/** Age of the CURRENT state (right column). */
	stateAgeMs: number;
	/** First line of the child's last message — the callout's question
	 * preview (blocked pi children only). */
	blockedPreview?: string;
}

export interface WidgetModel {
	rows: WidgetRow[];
	/** Header counts: active vs open (everything still tracked). */
	active: number;
	open: number;
	/** active = 0 — amber-border signal. */
	idle: boolean;
}

/** Per-agent display bookkeeping: state episodes + the elapsed freeze.
 * `elapsedMs`/`frozenFor` survive episode resets: the freeze is stamped
 * against the `startedAt` it was measured from, so a transient blip out of
 * `finalizing` (last-known fallback) can't lose it — while a resume (fresh
 * `startedAt`) recomputes honestly. */
interface CacheEntry {
	state: string;
	since: number;
	/** Elapsed stamped when `finalizing` was first rendered. */
	elapsedMs?: number;
	/** The `startedAt` the freeze was stamped against. */
	frozenFor?: number;
}

export type WidgetCache = Map<string, CacheEntry>;

/** A projection plus the caller-precomputed extras. */
export type WidgetProjection = Projection & {
	stateAgeMs?: number;
	blockedPreview?: string;
};

/** The record fields the widget reads beyond the projection's subset. */
export type WidgetRecord = ProjectableRecord & {
	name: string;
	type?: string;
	spawnedAt: number;
	startedAt?: number;
};

/**
 * Build the render model. `projections` is pairwise with `records` (the
 * caller runs `projectStatus` + reads; see `fleetWidgetOnce`). Ages fall
 * back to the first-seen cache for states without a clock (blocked, coarse
 * running); the cache restarts an episode on state change. Pure apart from
 * the cache.
 */
export function buildWidgetModel(
	records: WidgetRecord[],
	projections: WidgetProjection[],
	now: number,
	cache: WidgetCache,
): WidgetModel {
	const rows: WidgetRow[] = [];
	for (let i = 0; i < records.length; i++) {
		const record = records[i];
		const proj = projections[i];
		if (record.delivery) continue; // rows leave on delivery — not a morgue

		const prev = cache.get(record.name);
		const frozen =
			prev?.elapsedMs !== undefined && prev.frozenFor === record.startedAt
				? prev.elapsedMs
				: undefined;
		let entry = prev;
		if (!entry || entry.state !== proj.status) {
			entry = { state: proj.status, since: now, elapsedMs: frozen };
			if (frozen !== undefined) entry.frozenFor = record.startedAt;
			cache.set(record.name, entry);
		}

		// Process elapsed: counts from the pane start (spawn accept when the
		// pane never started), FREEZING at finalizing.
		let elapsedMs = now - (record.startedAt ?? record.spawnedAt);
		if (proj.status === "finalizing") {
			entry.elapsedMs ??= elapsedMs;
			entry.frozenFor ??= record.startedAt;
		}
		if (entry.elapsedMs !== undefined && entry.frozenFor === record.startedAt)
			elapsedMs = entry.elapsedMs;

		// State age: caller-precomputed (snapshot clocks) wins; then the
		// record's own clocks; then the first-seen episode cache.
		let stateAgeMs = proj.stateAgeMs;
		if (stateAgeMs === undefined) {
			if (record.interruptedAt !== undefined) stateAgeMs = now - record.interruptedAt;
			else if (record.watch?.problemSince !== undefined)
				stateAgeMs = now - record.watch.problemSince;
			else if (!record.paneId) stateAgeMs = now - record.spawnedAt;
			else stateAgeMs = now - entry.since;
		}

		rows.push({
			name:
				record.type && record.type !== record.name
					? `${record.name} (${record.type})`
					: record.name,
			status: proj.status,
			detail: proj.detail,
			elapsedMs,
			stateAgeMs,
			blockedPreview: proj.blockedPreview,
		});
	}
	const active = rows.filter((r) => ACTIVE_STATES.has(r.status)).length;
	return { rows, active, open: rows.length - active, idle: active === 0 };
}

// ---- pure rendering ------------------------------------------------------------

export function formatElapsed(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const m = Math.floor(total / 60);
	const s = total % 60;
	return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** Theme-ish style adapter; the default renders plain (offline tests pin
 * layout). `border` receives the box/header dashes — the caller picks the
 * color (amber when the model is idle). */
export interface WidgetStyle {
	dim(s: string): string;
	border(s: string): string;
	inverse(s: string): string;
}

const PLAIN: WidgetStyle = {
	dim: (s) => s,
	border: (s) => s,
	inverse: (s) => s,
};

const visibleLen = (s: string): number => s.replace(/\x1b\[[0-9;]*m/g, "").length;

function fit(s: string, n: number): string {
	return s.length <= n ? s : `${s.slice(0, Math.max(1, n - 1))}…`;
}

/**
 * The table + blocked callout, as plain lines (never wider than `width`).
 * Ages sit dim on the right; the border (all four edges) goes amber when
 * nothing is active; blocked rows repeat beneath the box as the inverse
 * callout with the question preview.
 */
export function renderWidgetLines(
	model: WidgetModel,
	width: number,
	style: WidgetStyle = PLAIN,
): string[] {
	const cells = model.rows.map((r) => ({
		name: r.name,
		left: `${formatElapsed(r.elapsedMs)}  ${r.name}`,
		mid: r.detail ? `${r.status} · ${r.detail}` : r.status,
		age: formatAge(r.stateAgeMs),
		callout: r.status === "blocked",
		preview: r.blockedPreview,
	}));

	const counts = `${model.active} active · ${model.open} open`;
	const maxL = Math.max(0, ...cells.map((c) => c.left.length));
	const maxM = Math.max(0, ...cells.map((c) => c.mid.length));
	const maxA = Math.max(0, ...cells.map((c) => c.age.length), 2);

	// Full table width F (visible chars incl. the │╭╮ edges): hug the content,
	// cap at the terminal, keep the header's minimal shape intact. Row layout
	// inside the box: ` ` + LEFT + 2sp + MID + 1sp + AGE + ` ` — so a row is
	// maxL + maxM + maxA + 5 wide between the bars, +2 with them.
	const natural = maxL + maxM + maxA + 7;
	const headerMin = counts.length + 18; // `─ Subagents ─ N active · M open ─`
	let F = Math.min(Math.max(20, width), Math.max(natural, headerMin));
	if (F < headerMin) F = headerMin; // absurdly narrow — hard-fit below

	// Shrink the name column first, then the state column (ages stay honest).
	let LW = maxL;
	let MW = maxM;
	const budget = F - 7 - maxA; // LW + MW ≤ this keeps a row at width F
	if (LW + MW > budget) LW = Math.max(8, budget - MW);
	if (LW + MW > budget) MW = Math.max(6, budget - LW);

	const bar = style.border("│");
	const lines: string[] = [];
	const callouts: string[] = [];

	// header: ╭─ Subagents ────── N active · M open ─╮
	const dashes = F - counts.length - 16; // ≥ 2 given F ≥ headerMin
	const headContent = `─ Subagents ${"─".repeat(dashes - 1)} ${counts} ─`;
	lines.push(style.border("╭") + style.border(hardFit(headContent, F - 2)) + style.border("╮"));

	for (const c of cells) {
		const content = hardFit(
			` ${fit(c.left, LW)}${" ".repeat(Math.max(0, LW - c.left.length))}  ` +
				`${fit(c.mid, MW)}${" ".repeat(Math.max(0, MW - c.mid.length))} ` +
				`${c.age.padStart(maxA)} `,
			F - 2,
		);
		lines.push(bar + content + bar);
		if (c.callout) callouts.push(calloutLine(c.name, c.age, c.preview, width, style));
	}

	const footContent = "─".repeat(Math.max(1, F - 2));
	lines.push(style.border("╰") + style.border(footContent) + style.border("╯"));
	// The blocked callout sits beneath the whole table — the widget's one
	// loud alarm (kept v0.5 amendment; the box is the quiet ambient view).
	lines.push(...callouts);
	return lines;
}

function hardFit(s: string, n: number): string {
	return visibleLen(s) <= n ? s : `${s.slice(0, Math.max(1, n - 1))}…`;
}

/** ` ⚠ name BLOCKED ` (inverse) + age + the question preview, truncated.
 * Every piece is pre-fitted to a width-derived budget, so the composed line
 * never needs a raw-index cut (that would split ANSI escapes mid-sequence). */
function calloutLine(
	name: string,
	age: string,
	preview: string | undefined,
	width: number,
	style: WidgetStyle,
): string {
	const head = ` ⚠ ${fit(name, Math.max(8, width / 3))} BLOCKED `;
	let line = style.inverse(head) + ` ${age} `;
	if (preview) {
		const budget = width - visibleLen(head) - age.length - 6;
		if (budget >= 8) line += style.dim(`"${fit(preview, budget)}"`);
	}
	return line;
}

// ---- the tick ----------------------------------------------------------------

/** Injectable seams (offline red-green; defaults hit the registry + disk +
 * the UI captured by registerFleetWidget). */
export interface WidgetDeps {
	registry?: () => ReadonlyMap<string, SpawnRecord>;
	/** Pre-fetched fleet observation — the SAME one delivery/watchdog used. */
	fleet?: Result<NormalizedAgent[]>;
	readSidecar?: (sessionPath: string) => ReadSidecarResult;
	readActivity?: (activityPath?: string) => ActivityRead;
	extract?: (sessionPath: string) => ExtractedResult | null;
	now?: () => number;
	/** The setWidget sink — default: the orchestrator's ctx.ui. */
	ui?: UiSink;
}

/** Minimal structural view of the widget sink we need. */
export interface WidgetTheme {
	fg(color: string, text: string): string;
	inverse(text: string): string;
}

export interface WidgetComponent {
	render(width: number): string[];
	invalidate(): void;
}

export interface UiSink {
	setWidget(
		key: string,
		content: ((tui: unknown, theme: WidgetTheme) => WidgetComponent) | undefined,
	): void;
}

export const WIDGET_KEY = "herdr-fleet";

let ui: UiSink | undefined;
let shown = false;
const cache: WidgetCache = new Map();

/** Capture the orchestrator UI (TUI/RPC only) + reset on session end. */
export function registerFleetWidget(pi: ExtensionAPI): void {
	pi.on("session_start", (_e, ctx) => {
		ui = ctx.hasUI ? (ctx.ui as UiSink) : undefined;
	});
	pi.on("session_shutdown", () => {
		ui = undefined;
		shown = false;
		cache.clear();
	});
}

/** The question preview: the blocked child's last assistant message — its
 * first non-empty line, ellipsis-truncated. (Read per tick while blocked:
 * blocked episodes are rare and brief.) */
function questionPreview(
	record: WidgetRecord,
	extract: (path: string) => ExtractedResult | null,
): string | undefined {
	if (!isSubstrateChild(record) || !record.sessionPath) return undefined;
	const text = extract(record.sessionPath)?.text ?? "";
	const line = text
		.split("\n")
		.map((l) => l.trim())
		.find((l) => l.length > 0);
	return line ? fit(line, 120) : undefined;
}

/** Snapshot clocks for the state-age column: how long the child has been in
 * its current phase, straight from the activity sidecar. */
function snapshotAgeMs(
	proj: Projection,
	activity: ActivityRead,
	now: number,
): number | undefined {
	if (activity.state !== "ok") return undefined;
	const a = activity.activity;
	if (proj.status === "active" && a.activeSince !== undefined)
		return now - a.activeSince;
	if (proj.status === "waiting" && a.waitingSince !== undefined)
		return now - a.waitingSince;
	return undefined;
}

/**
 * One widget pass: project the registry, prune delivered rows, render. A
 * failed fleet observation renders the last-known view (never absence
 * evidence). No in-flight rows (empty registry, or every record delivered —
 * the registry never shrinks) clears the widget — once.
 */
export async function fleetWidgetOnce(deps: WidgetDeps = {}): Promise<void> {
	const registry = (deps.registry ?? spawnRecords)();
	const sink = deps.ui ?? ui;
	if (!sink) return; // no UI (print mode / pre-session_start): no reads at all
	const now = deps.now ?? (() => Date.now());
	const readSidecar = deps.readSidecar ?? readExitSidecar;
	const readActivity = deps.readActivity ?? readActivityFile;
	const extract = deps.extract ?? extractSessionResult;

	const clearOnce = (): void => {
		if (shown) sink.setWidget(WIDGET_KEY, undefined);
		shown = false;
		cache.clear();
	};

	// Rows leave on delivery — the table is in-flight work only, not a morgue
	// (the registry keeps delivered records, so an empty ROWS view must clear
	// exactly like an empty registry would).
	const records = [...registry.values()].filter((r) => !r.delivery);
	if (records.length === 0) {
		clearOnce();
		return;
	}

	const live = new Map<string, string>();
	const fleet = deps.fleet;
	const fleetOk = fleet !== undefined && fleet.ok;
	if (fleet && fleet.ok) {
		for (const a of fleet.data) {
			if (a.paneId && a.agentStatus) live.set(a.paneId, a.agentStatus);
		}
	}

	const projections = records.map((record) => {
		const paneId = record.paneId;
		const activity = readActivity(record.activityPath); // one read per tick
		const proj = projectStatus(record, {
			live: paneId ? live.get(paneId) : undefined,
			absent: fleetOk && paneId !== undefined && !live.has(paneId),
			unhealthy: !fleetOk,
			sidecar: Boolean(
				isSubstrateChild(record) &&
					record.sessionPath &&
					readSidecar(record.sessionPath).state === "ok",
			),
			activity,
			now: now(),
		});
		return {
			...proj,
			stateAgeMs: snapshotAgeMs(proj, activity, now()),
			blockedPreview:
				proj.status === "blocked" ? questionPreview(record, extract) : undefined,
		};
	});

	// GC: entries for records that left the registry.
	const names = new Set(records.map((r) => r.name));
	for (const k of cache.keys()) if (!names.has(k)) cache.delete(k);

	shown = true;
	const model = buildWidgetModel(records, projections, now(), cache);
	sink.setWidget(WIDGET_KEY, (_tui, theme) => ({
		render: (width) =>
			renderWidgetLines(model, width, {
				dim: (s) => theme.fg("dim", s),
				border: (s) => theme.fg(model.idle ? "warning" : "border", s),
				inverse: (s) => theme.inverse(s),
			}),
		invalidate: () => {},
	}));
}
