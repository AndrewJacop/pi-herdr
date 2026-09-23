/**
 * progress.ts — the workflow progress model.
 *
 * PORTED from tintinweb/pi-subagents `src/workflow/progress.ts` (MIT; clone
 * at `.scratch/pi-subagents/`, gitignored). Ported with trims decided by the
 * v0.6 issue-14 ruling; provenance kept in this header per the honesty
 * ruling — see the README acknowledgement:
 *
 *   - no `attempt`/`lastAttemptReason` — there are no skip/retry intents
 *     without run control (the FleetView inspector is post-v0.6);
 *   - no size warning, no footer phase label/gerund — our footer is
 *     diagnostics-only (issue 11) and no token-cap setting exists.
 *
 * Progress is an **append-only event log**, not a tree. Agent entries are
 * keyed by `index` and last-write-wins, so a running agent is updated by
 * appending a fresh entry with the same index rather than mutating anything.
 * Every view — the card (card.ts), the widget's workflow row (widget.ts) —
 * derives its shape by collapsing that log.
 *
 * Two vocabularies, deliberately distinct:
 *   - entry `state` is only start | progress | done | error, with `skipped`,
 *     `blocked` and `cached` as separate booleans;
 *   - the display state adds queued, running, interrupted, skipped, blocked
 *     and failed, and is *derived* (see `displayState`).
 *
 * Everything in this file is pure and framework-free so the whole model is
 * unit-testable without a terminal.
 */

/** Raw entry lifecycle, as written by the runtime. */
export type WorkflowEntryState = "start" | "progress" | "done" | "error";

/** Derived per-agent state, as rendered. */
export type WorkflowDisplayState =
	| "queued"
	| "running"
 | "done"
	| "failed"
	| "skipped"
	| "interrupted";

export interface WorkflowPhaseEntry {
	type: "workflow_phase";
	index: number;
	title: string;
}

export interface WorkflowLogEntry {
	type: "workflow_log";
	message: string;
}

export interface WorkflowAgentEntry {
	type: "workflow_agent";
	/** Stable identity. Re-emitting this index replaces the previous entry. */
	index: number;
	label: string;
	state: WorkflowEntryState;
	agentId: string;
	agentType: string;
	model?: string;
	isolation?: "worktree";
	/** Absent when the agent ran before any `phase()` call. */
	phaseIndex?: number;
	phaseTitle?: string;
	promptPreview?: string;
	queuedAt?: number;
	startedAt?: number;
	lastProgressAt?: number;
	/** Settled duration; live rows derive theirs from `startedAt` instead. */
	durationMs?: number;
	resultPreview?: string;
	error?: string;
	/** The user dismissed it rather than it failing; renders as skipped. */
	skipped?: boolean;
	/** Set when the answer came from the resume journal, not a live child. */
	cached?: boolean;
	/** Completed tool calls, recovered from the child's session JSONL (14). */
	toolCalls?: number;
}

export type WorkflowEntry =
	| WorkflowPhaseEntry
	| WorkflowLogEntry
	| WorkflowAgentEntry;

/* ------------------------------------------------------------------------- *
 * The model (ported from upstream `progress.ts` with the trims named above)
 * ------------------------------------------------------------------------- */

export interface CollapsedProgress {
	agents: WorkflowAgentEntry[];
	logs: string[];
	phaseTitles: Map<number, string>;
}

export interface PhaseGroup {
	title: string;
	status: "not-started" | "running" | "done" | "failed";
	agents: WorkflowAgentEntry[];
	doneCount: number;
	totalCount: number;
	durationMs: number;
}

export interface WorkflowStats {
	done: number;
	failedCount: number;
	running: boolean;
	total: number;
}

/**
 * Fold the event log into its latest state.
 *
 * Agent entries collapse by index (last write wins); logs accumulate in
 * order; phase titles are a lookup for grouping.
 */
export function collapse(progress: readonly WorkflowEntry[]): CollapsedProgress {
	const agents = new Map<number, WorkflowAgentEntry>();
	const logs: string[] = [];
	const phaseTitles = new Map<number, string>();

	for (const entry of progress) {
		if (entry.type === "workflow_agent") agents.set(entry.index, entry);
		else if (entry.type === "workflow_log") logs.push(entry.message);
		else phaseTitles.set(entry.index, entry.title);
	}

	return {
		agents: [...agents.values()].sort((a, b) => a.index - b.index),
		logs,
		phaseTitles,
	};
}

/**
 * Derive what to render for one agent.
 *
 * `workflowActive` is false once the run has stopped: anything still
 * mid-flight at that point was cut off rather than finished, hence
 * "interrupted". No `blocked` state (upstream has one): pi-herdr workflow
 * children never settle blocked — the host keeps the call waiting (issue 12).
 */
export function displayState(entry: WorkflowAgentEntry, workflowActive: boolean): WorkflowDisplayState {
	if (entry.state === "done") return "done";
	if (entry.state === "error") {
		if (entry.skipped) return "skipped";
		return "failed";
	}
	if (!workflowActive) return "interrupted";
	// Queued means accepted but never given a slot.
	return entry.queuedAt != null && entry.startedAt == null ? "queued" : "running";
}

/** True while an entry is still expected to change. */
export function isLive(entry: WorkflowAgentEntry): boolean {
	return entry.state === "start" || entry.state === "progress";
}

/** Bucket agents by phase. Returns null when no agent declared a phase. */
function groupByPhase(
	agents: readonly WorkflowAgentEntry[],
	phaseTitles: Map<number, string>,
): { phaseIndex: number; title: string; agents: WorkflowAgentEntry[] }[] | null {
	if (!agents.some((a) => a.phaseIndex != null)) return null;

	const byPhase = new Map<number, { phaseIndex: number; title: string; agents: WorkflowAgentEntry[] }>();
	for (const agent of agents) {
		const phaseIndex = agent.phaseIndex ?? 0;
		let group = byPhase.get(phaseIndex);
		if (!group) {
			group = { phaseIndex, title: phaseTitles.get(phaseIndex) ?? `Phase ${phaseIndex}`, agents: [] };
			byPhase.set(phaseIndex, group);
		}
		group.agents.push(agent);
	}
	return [...byPhase.values()].sort((a, b) => a.phaseIndex - b.phaseIndex);
}

/** Roll a phase's agents up into the counts and totals its header shows. */
function summarize(group: { title: string; agents: WorkflowAgentEntry[] }): PhaseGroup {
	let done = 0;
	let failed = 0;
	let minStart = Number.POSITIVE_INFINITY;
	let maxProgress = 0;

	for (const agent of group.agents) {
		if (agent.state === "done") done++;
		else if (agent.state === "error") failed++;
		if (agent.startedAt != null) {
			if (agent.startedAt < minStart) minStart = agent.startedAt;
			const last = agent.lastProgressAt ?? agent.startedAt;
			if (last > maxProgress) maxProgress = last;
		}
	}

	const total = group.agents.length;
	const finished = done + failed === total && total > 0;
	return {
		title: group.title,
		status: finished ? (failed > 0 ? "failed" : "done") : "running",
		agents: group.agents,
		doneCount: done,
		totalCount: total,
		// Wall-clock across the phase, not the sum of its agents: they overlap.
		durationMs: minStart < Number.POSITIVE_INFINITY ? maxProgress - minStart : 0,
	};
}

/** A phase declared in `meta` that has not produced any agent yet. */
function placeholder(title: string): PhaseGroup {
	return { title, status: "not-started", agents: [], doneCount: 0, totalCount: 0, durationMs: 0 };
}

const normalizeTitle = (title: string) => title.toLowerCase().trim();

/**
 * Reconcile the phases declared in `meta` with the phases actually observed.
 *
 * Matching is fuzzy on purpose: a script may call `phase("Review")` against
 * a declared `{ title: "Review changed files" }`, and upstream treats those
 * as the same phase when either title is a prefix of the other. Each
 * observed group is consumed at most once, declared-but-unseen phases render
 * as not-started placeholders, and observed groups with no declaration are
 * appended after — that is how an undeclared `phase()` "gets its own group".
 */
function mergePhases(
	declared: readonly { title: string }[] | undefined,
	observed: { phaseIndex: number; title: string; agents: WorkflowAgentEntry[] }[],
): PhaseGroup[] {
	const consumed = new Set<{ phaseIndex: number; title: string; agents: WorkflowAgentEntry[] }>();
	const merged: PhaseGroup[] = [];

	for (const phase of declared ?? []) {
		const wanted = normalizeTitle(phase.title);
		const match = observed.find((group) => {
			if (consumed.has(group)) return false;
			const actual = normalizeTitle(group.title);
			return actual === wanted || actual.startsWith(wanted) || wanted.startsWith(actual);
		});
		if (match) {
			consumed.add(match);
			merged.push(summarize(match));
		} else {
			merged.push(placeholder(phase.title));
		}
	}

	for (const group of observed) {
		if (!consumed.has(group)) merged.push(summarize(group));
	}

	return merged;
}

/**
 * Build the phase groups a renderer walks.
 *
 * When nothing declared or emitted a phase, every agent collapses into a
 * single group titled "Agents" so the tree still has one level of structure.
 * A run that declared phases but produced un-phased agents would otherwise
 * render placeholders and drop those agents from the tree entirely — the
 * extra trailing group keeps the work visible (upstream's divergence note).
 */
export function buildPhaseGroups(
	progress: readonly WorkflowEntry[],
	declared?: readonly { title: string }[],
): PhaseGroup[] {
	const { agents, phaseTitles } = collapse(progress);
	const observed = groupByPhase(agents, phaseTitles) ?? [];
	const merged = mergePhases(declared, observed);
	if (merged.length === 0 && agents.length > 0) {
		return [summarize({ title: "Agents", agents })];
	}
	if (agents.length > 0 && !merged.some((group) => group.totalCount > 0)) {
		return [...merged, summarize({ title: "Agents", agents })];
	}
	return merged;
}

/**
 * Aggregate counts for the header line.
 *
 * `agentCount` — the number the runtime has *scheduled* — can exceed the
 * number that has emitted an entry elsewhere; in this runtime every
 * scheduled agent emits its entry at call time, so `seen` already leads.
 */
export function stats(progress: readonly WorkflowEntry[], agentCount = 0): WorkflowStats {
	let seen = 0;
	let done = 0;
	let failed = 0;
	let anyLive = false;

	for (const entry of progress) {
		if (entry.type !== "workflow_agent") continue;
		seen++;
		if (entry.state === "done") done++;
		else if (entry.state === "error") failed++;
		else anyLive = true;
	}

	return {
		done,
		failedCount: failed,
		running: anyLive,
		total: Math.max(agentCount, seen),
	};
}

/** Elapsed run time. */
export function elapsedMs(
	run: { startedAt: number; endedAt?: number },
	now: number,
): number {
	return Math.max(0, (run.endedAt ?? now) - run.startedAt);
}

const plural = (n: number, word: string) => (n === 1 ? word : `${word}s`);

/** `1m12s` / `9s` / `340ms` — matching how the rest of the extension reads. */
export function formatDuration(ms: number): string {
	if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
	const totalSeconds = Math.round(ms / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes === 0) return `${seconds}s`;
	return `${minutes}m${seconds.toString().padStart(2, "0")}s`;
}

export interface WorkflowHeader {
	name: string;
	stats: string;
}

/**
 * The one-line summary above the tree: `3/7 agents · 1m12s`.
 *
 * No terminal suffix (upstream has one): the card clears at settle in
 * pi-herdr — the completion push is the terminal report.
 */
export function header(
	run: { name: string; startedAt: number; endedAt?: number },
	groups: readonly PhaseGroup[],
	agentCount: number,
	now: number,
): WorkflowHeader {
	let doneAgents = 0;
	let totalAgents = 0;
	for (const group of groups) {
		doneAgents += group.doneCount;
		totalAgents += group.totalCount;
	}
	totalAgents = Math.max(agentCount, totalAgents, doneAgents);

	return {
		name: run.name,
		stats: `${doneAgents}/${totalAgents} ${plural(totalAgents, "agent")} · ${formatDuration(elapsedMs(run, now))}`,
	};
}
