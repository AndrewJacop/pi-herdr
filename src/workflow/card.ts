// card.ts — the live workflow progress card (v0.6 issue 14, ours).
//
//   review-changes                    1/2 agents · 1m12s
//   Review the diff
//     ╭─ Review
//     │ ├─ ✔ review:bugs  · general-purpose · done · 3 tool calls · 42s
//     │ └─ ⟳ review:perf · general-purpose · running · 21s
//     ╰─ Verify
//       └─ ▪ verify:auth · general-purpose · queued
//     ⎿  scanned 41 changed files
//
// Arrangement ported from tintinweb/pi-subagents `src/ui/workflow-card.ts`
// (MIT; clone at `.scratch/pi-subagents/`, gitignored) with trims decided by
// the issue-14 ruling: plain text lines (no segment/theme split — the card is
// an ambient read-only view, like the fleet widget), no size warning, no
// terminal suffix (the card clears at settle; the completion push is the
// terminal report), queued rows get a `▪` glyph. All state derivation lives
// in progress.ts; this file only arranges what that module returns.
//
// Mount: a SECOND widget slot above the editor (`herdr-workflow`), driven by
// its own 1s clock — the glyphs are static, only the elapsed time moves, so
// there is nothing to animate faster (upstream's WORKFLOW_TICK_MS rationale).
// It reads the runs registry in memory; it is a render cadence, not a poll
// tier — no herdr calls, no disk reads.

import {
	buildPhaseGroups,
	collapse,
	displayState,
	formatDuration,
	header,
	type PhaseGroup,
	type WorkflowAgentEntry,
} from "./progress.js";
import type { WorkflowRun } from "./runs.js";

/** Widest label column before stats stop being aligned and just follow. */
const LABEL_COLUMN_MAX = 28;

const GLYPHS = { done: "✔", failed: "✘", running: "⟳", queued: "▪" } as const;

/** What a replayed row says instead of a duration it does not have. */
const REPLAYED_ANNOTATION = "from resume journal";

const truncate = (text: string, width: number): string =>
	text.length <= width ? text : `${text.slice(0, Math.max(1, width - 1))}…`;

/** The `·`-separated tail of an agent row, in the recovered order: type,
 * state, tool calls, duration. Absent values drop out rather than render a
 * placeholder — except state, which the ticket's row contract always shows. */
function agentStatSegments(entry: WorkflowAgentEntry, state: string, now: number): string[] {
	const parts: string[] = [];
	if (entry.agentType) parts.push(entry.agentType);
	parts.push(state);
	if (entry.toolCalls) parts.push(`${entry.toolCalls} tool call${entry.toolCalls === 1 ? "" : "s"}`);
	if (entry.cached) parts.unshift(REPLAYED_ANNOTATION);
	if (entry.state === "done" || entry.state === "error") {
		if (entry.durationMs !== undefined) parts.push(formatDuration(entry.durationMs));
	} else if (entry.startedAt !== undefined) {
		// Live: the row's own clock, not a duration it does not have yet.
		parts.push(formatDuration(Math.max(0, now - entry.startedAt)));
	}
	return parts;
}

function rowGlyph(entry: WorkflowAgentEntry, state: string): string {
	if (entry.state === "done") return GLYPHS.done;
	if (entry.state === "error") return GLYPHS.failed;
	if (state === "queued") return GLYPHS.queued;
	return GLYPHS.running;
}

/** One phase group: the group line, then its agent rows under a rail. */
function layoutGroup(
	group: PhaseGroup,
	index: number,
	total: number,
	labelColumn: number,
	now: number,
	width: number,
): string[] {
	const lines: string[] = [];
	// One box, not a stack of them (upstream's rule): only the first group
	// opens it and only the last closes it; everything between branches off
	// the side — three phases must not read as three half-drawn boxes.
	const isLast = index === total - 1;
	const edge = isLast ? "╰─" : index === 0 ? "╭─" : "├─";
	lines.push(truncate(`  ${edge} ${group.title}`, width));

	const rail = isLast ? "  " : "│ ";
	for (const entry of group.agents) {
		const state = displayState(entry, true);
		const branch = entry === group.agents[group.agents.length - 1] ? "└─" : "├─";
		const glyph = rowGlyph(entry, state);
		const pad = Math.max(0, labelColumn - entry.label.length);
		const statsTail = agentStatSegments(entry, state, now);
		const tail = statsTail.length > 0 ? ` · ${statsTail.join(" · ")}` : "";
		lines.push(
			truncate(`  ${rail}${branch} ${glyph} ${entry.label}${" ".repeat(pad)}${tail}`, width),
		);
	}
	return lines;
}

/** One live run as card lines: header, description, phase tree, logs. */
export function layoutWorkflowCard(run: WorkflowRun, now: number, width: number): string[] {
	const groups = buildPhaseGroups(run.progress, run.meta.phases);
	const { agents, logs } = collapse(run.progress);
	const head = header(
		{ name: run.meta.name, startedAt: run.startedAt, ...(run.endedAt !== undefined ? { endedAt: run.endedAt } : {}) },
		groups,
		0,
		now,
	);

	const lines: string[] = [];
	// Name left, stats flush right (upstream's header arrangement).
	const gap = Math.max(1, width - head.name.length - head.stats.length - 2);
	lines.push(`  ${head.name}${" ".repeat(gap)}${head.stats}`);
	if (run.meta.description) lines.push(truncate(`  ${run.meta.description}`, width));

	const labelColumn = Math.min(
		LABEL_COLUMN_MAX,
		Math.max(0, ...agents.map((a) => a.label.length)),
	);
	groups.forEach((group, i) => {
		lines.push(...layoutGroup(group, i, groups.length, labelColumn, now, width));
	});

	// log() output, below the tree (upstream's ⎿ prefix, continuation indent).
	for (const message of logs) {
		const [first, ...rest] = message.split("\n");
		lines.push(truncate(`  ⎿  ${first}`, width));
		for (const continuation of rest) lines.push(truncate(`     ${continuation}`, width));
	}
	return lines;
}

/** Several live runs as one card: blocks separated by a blank line. */
export function layoutWorkflowCards(
	runs: readonly WorkflowRun[],
	now: number,
	width: number,
): string[] {
	const blocks = runs.map((run) => layoutWorkflowCard(run, now, width));
	const lines: string[] = [];
	blocks.forEach((block, i) => {
		if (i > 0) lines.push("");
		lines.push(...block);
	});
	return lines;
}

// The card has NO widget slot of its own (manual e2e F9): pi re-stacks
// widgets on every setWidget (delete + append), so two self-refreshing
// widgets flip vertical order forever. The fleet widget (src/widget.ts)
// renders these lines beneath its table on the delivery tick — one slot,
// one owner. This file stays the pure layout.
