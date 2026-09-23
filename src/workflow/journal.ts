/**
 * journal.ts — the record a workflow run leaves so a later run can skip work.
 *
 * PORTED from tintinweb/pi-subagents `src/workflow/journal.ts` (MIT; clone at
 * `.scratch/pi-subagents/`, gitignored). Ported near-verbatim — provenance kept
 * in this header per the v0.6 issue-12 honesty ruling; see the README
 * acknowledgement. One pi-herdr trim (issue 12) is now reverted: the `schema`
 * slot in {@link journalKey} arrived with issue 14, appended conditionally
 * exactly as upstream does, so journals already on disk keep their keys.
 *
 * ## What resume actually buys
 *
 * The documented iteration loop is "edit the persisted script and re-run it".
 * Without a journal that re-pays every agent from scratch, which for a 40-agent
 * audit is the entire cost of the run — to change one line of the last stage.
 * With one, the unchanged prefix comes back from disk and only the edit runs.
 *
 * ## Why a *prefix*, and not a lookup table
 *
 * Each entry is keyed by both its position in the run and a hash of everything
 * that decides what that agent does. A replay walks positions in order and
 * stops reusing at the first entry that does not match — every call from there
 * on runs live. Reusing later matches out of order would be reusing a result
 * produced under different upstream conditions: the same prompt at position 12
 * of a *different* run is not the same work, because what fed it changed.
 *
 * A failed agent is journaled as a failure and never replayed as one. Resuming
 * a run that died at agent 5 exists to retry agent 5, so the prefix ends there
 * and 5 onwards run live — the alternative would make a failure permanent.
 *
 * ## Runs that use `agent({ resume })`
 *
 * Those are not replayed at all. A replayed agent is text from a file, not a
 * live child, so there is no conversation in this run for a later `resume` to
 * continue — and the id map that would find one belongs to the run that did
 * the spawning. Rather than replay a prefix that strands the first `resume`
 * call, a journal carrying one declines the whole cache and the run pays in
 * full. Coarse on purpose: the alternative is tracking which label each entry
 * ran under and capping the prefix below the earliest one that gets resumed,
 * which is a second key concept for a case that costs one run.
 *
 * ## Ordering under concurrency
 *
 * Positions are assigned as calls arrive, and with `pipeline` that order
 * depends on which agent finished first. A replay usually reproduces it, since
 * cached calls answer in journal order, but it is not guaranteed. That is why
 * the key is checked as well as the position: a run that interleaves
 * differently loses cache hits, it never returns another agent's answer.
 *
 * The file is JSON Lines, appended as each agent settles, so a run that is
 * killed mid-flight still leaves everything it had finished.
 */

import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** One settled agent call, as replayed. */
export interface WorkflowJournalEntry {
	/** Position in the run — the same counter that names `wf-agent-N`. */
	index: number;
	/** Hash of the call's payload; a mismatch ends the replayable prefix. */
	key: string;
	/** Whether the agent succeeded. A failure ends the prefix on replay. */
	ok: boolean;
	/** The agent's answer, when it had one. */
	text?: string;
	/**
	 * Whether the call continued an earlier child (`agent({ resume })`).
	 *
	 * A replayed agent leaves no session behind in the run that replays it — the
	 * conversation belongs to the run that actually spawned it, and the host's
	 * id map is per-run — so a later `resume` would have nothing to continue.
	 * Recording it lets the next run decline to replay at all rather than fail
	 * partway through, which is why the flag is on the journal and not derived.
	 */
	resumed?: true;
}

/**
 * The scratch directory: `<tmp>/pi-herdr-workflows/` — run scripts, resume
 * journals and (issue 14) per-agent schema files live here, keyed by run id.
 * Lives in journal.ts (a leaf) rather than runs.ts so the host can import it
 * without an import cycle: runs.ts constructs the host.
 */
export function workflowScratchDir(): string {
	return join(tmpdir(), "pi-herdr-workflows");
}

/**
 * The fields that decide what an agent does.
 *
 * Deliberately not the whole payload: `phaseIndex` and `phaseTitle` move the
 * row around in the progress tree without changing a single token the agent
 * sees, so re-grouping phases should not throw away an hour of results.
 */
export interface JournalKeyInput {
	prompt: string;
	label?: string;
	model?: string;
	agentType?: string;
	effort?: string;
	isolation?: string;
	gate?: string;
	resume?: string;
	/** The call's schema, SERIALIZED (issue 14) — the runtime stringifies the
	 * raw object, so a changed schema changes the key and ends the prefix. */
	schema?: string;
}

/** Stable hash of a call's payload. Field order is fixed here, not by the caller. */
export function journalKey(input: JournalKeyInput): string {
	const canonical = JSON.stringify([
		input.prompt,
		input.label ?? null,
		input.model ?? null,
		input.agentType ?? null,
		input.effort ?? null,
		input.isolation ?? null,
		input.gate ?? null,
		input.resume ?? null,
		// Appended when issue 14 added it — journals written before then never
		// carried a schema, and the null keeps their keys byte-identical.
		...(input.schema !== undefined ? [input.schema] : []),
	]);
	return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

/**
 * Read a journal file into position order.
 *
 * Never throws: a missing, truncated or hand-mangled journal means "nothing to
 * replay", which costs tokens. Refusing to run would cost the whole run.
 * A partial last line is normal — the file is appended to while agents settle.
 */
export function readJournal(path: string): WorkflowJournalEntry[] {
	let raw: string;
	try {
		raw = readFileSync(path, "utf-8");
	} catch {
		return [];
	}

	const entries: WorkflowJournalEntry[] = [];
	for (const line of raw.split("\n")) {
		if (line.trim() === "") continue;
		try {
			const parsed = JSON.parse(line) as unknown;
			if (!isEntry(parsed)) continue;
			entries.push(parsed);
		} catch {
			// A half-written final line, or someone editing the file. Skipping it
			// keeps what came before, and a shorter prefix is still a useful one.
		}
	}
	entries.sort((a, b) => a.index - b.index);
	return entries;
}

/** Append one settled call. Failure to write is not failure to run. */
export function appendJournal(path: string, entry: WorkflowJournalEntry): void {
	try {
		appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf-8");
	} catch {
		// A journal that cannot be written costs a future resume, nothing more.
	}
}

function isEntry(value: unknown): value is WorkflowJournalEntry {
	if (typeof value !== "object" || value === null) return false;
	const entry = value as Record<string, unknown>;
	return (
		Number.isInteger(entry.index) &&
		(entry.index as number) >= 0 &&
		typeof entry.key === "string" &&
		typeof entry.ok === "boolean" &&
		(entry.text === undefined || typeof entry.text === "string") &&
		(entry.resumed === undefined || entry.resumed === true)
	);
}
