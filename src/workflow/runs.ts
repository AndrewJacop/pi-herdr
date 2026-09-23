/**
 * runs.ts — the background workflow-run registry (ours, v0.6 issue 12).
 *
 * One place owns the lifecycle the tool kicks off: compose the run id, write
 * the script to its scratch file (the edit-and-re-run loop — issue 13's journal
 * lands beside it), start the runtime, and steer ONE aggregated completion
 * message into the orchestrator session when the run settles. Children are
 * stamped with the run id by the host; the delivery loop suppresses their
 * per-child pushes, so this is the run's single report.
 *
 * `session_shutdown` → {@link stopAllWorkflowRuns}: every worker is terminated
 * and its in-flight children closed host-side. A run does not outlive its
 * session (upstream's journal has the same scoping).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	runWorkflow,
	validateScript,
	type WorkflowAgentEntry,
	type WorkflowRunResult,
} from "./runtime.js";
import type { WorkflowMeta } from "./meta.js";
import { appendJournal, readJournal } from "./journal.js";
import { createWorkflowHost } from "./host.js";
import { makeDeliverySink, terminalWake, type SteeredMessage } from "../delivery.js";
import {
	getSettingsPaths,
	loadSettings,
	type HerdrSettings,
} from "../settings.js";

/** How much of the return value rides the completion push. */
const RESULT_PREVIEW_LENGTH = 2_000;

export interface WorkflowRun {
	runId: string;
	meta: WorkflowMeta;
	/** The scratch file the author edits and re-runs via `scriptPath`. */
	scriptPath: string;
	/** The resume journal: every settled `agent()` call, appended as it settles. */
	journalPath: string;
	/** The run this one resumed from, when it did (`resumeFromRunId`). */
	resumedFrom?: string;
	status: "running" | "completed" | "failed" | "killed";
	startedAt: number;
	/** Filled when the run settles. */
	result?: WorkflowRunResult;
}

const runs = new Map<string, WorkflowRun>();

/** Live run snapshot (tests). */
export function workflowRuns(): ReadonlyMap<string, WorkflowRun> {
	return runs;
}

/** `wf_` + hex — matches the resumeFromRunId shape issue 13 keys on. */
export function newWorkflowRunId(): string {
	return `wf_${randomBytes(6).toString("hex")}`;
}

/** The scratch directory: `<tmp>/pi-herdr-workflows/`. */
export function workflowScratchDir(): string {
	return join(tmpdir(), "pi-herdr-workflows");
}

export interface StartRunOptions {
	script: string;
	args?: unknown;
	pi: ExtensionAPI;
	ctx?: ExtensionContext;
	/** Override the host (tests) — default: createWorkflowHost on this session. */
	host?: import("./runtime.js").WorkflowHost;
	/** The steer sink (default: pi.sendMessage, delivery-style). */
	push?: (msg: SteeredMessage) => void;
	/** Injectable settings read (tests) — default: live read. */
	load?: () => HerdrSettings;
	now?: () => number;
	/**
	 * A prior run to replay from (`resumeFromRunId`, issue 13): its journal's
	 * unchanged prefix comes back from disk, and this run journals its own calls
	 * so it can be resumed in turn.
	 */
	resumeFrom?: { runId: string; journalPath: string };
	/**
	 * The source file the script came from (a scriptPath or a saved name) —
	 * reported as the run's scriptPath, so the edit-and-re-run loop edits THAT
	 * file rather than the scratch copy. Default: the scratch copy.
	 */
	sourcePath?: string;
}

export interface StartedRun {
	run: WorkflowRun;
	/** Resolves when the run settles (the tool does NOT await it). */
	done: Promise<WorkflowRunResult>;
}

/**
 * Start one workflow run in the background: scratch file → host → runtime.
 * The returned promise is for tests; the tool returns immediately.
 */
export function startWorkflowRun(options: StartRunOptions): StartedRun {
	const { script, args } = options;
	const { meta } = validateScript(script);
	const runId = newWorkflowRunId();

	const dir = workflowScratchDir();
	mkdirSync(dir, { recursive: true });
	const scriptPath = join(dir, `${runId}.workflow.js`);
	writeFileSync(scriptPath, script, "utf8");
	// The journal sits beside the script under the same id — what makes a run id
	// enough to resume from (issue 13; same-session only, like the run itself).
	const journalPath = join(dir, `${runId}.workflow.jsonl`);

	const run: WorkflowRun = {
		runId,
		meta,
		...(options.sourcePath !== undefined ? { scriptPath: options.sourcePath } : { scriptPath }),
		journalPath,
		...(options.resumeFrom !== undefined ? { resumedFrom: options.resumeFrom.runId } : {}),
		status: "running",
		startedAt: (options.now ?? (() => Date.now()))(),
	};
	runs.set(runId, run);

	const controller = new AbortController();
	abortBySession.set(runId, controller);

	// ONE sink factory (delivery.ts) — the run's completion report uses the
	// exact envelope the delivery loop steers with.
	const push = options.push ?? makeDeliverySink(options.pi);

	const host = options.host ?? createWorkflowHost({
		pi: options.pi,
		ctx: options.ctx,
		signal: controller.signal,
		runId,
	});

	const startedAt = run.startedAt;
	// Replay the prior run's settled calls; append this run's own as they settle.
	const replay = options.resumeFrom !== undefined ? readJournal(options.resumeFrom.journalPath) : [];
	const done = runWorkflow({
		script,
		args,
		host,
		signal: controller.signal,
		journal: {
			...(replay.length > 0 ? { entries: replay } : {}),
			append: (entry) => appendJournal(journalPath, entry),
		},
	})
		.then((result): WorkflowRunResult => {
			const finishedAt = (options.now ?? (() => Date.now()))();
			run.status = result.status;
			run.result = result;
			const notes = (options.load ?? defaultLoad)().notifications;
			push(completionMessage(run, result, finishedAt - startedAt, notes));
			return result;
		})
		.finally(() => {
			abortBySession.delete(runId);
		});

	return { run, done };
}

/** Per-run abort controllers — session shutdown stops every live run. */
const abortBySession = new Map<string, AbortController>();

/**
 * Stop every live run (session_shutdown): terminate the workers and abort the
 * run signal, which closes the in-flight children host-side. Runs already
 * settled are untouched. Runs do not outlive their session.
 */
export function stopAllWorkflowRuns(): void {
	for (const controller of abortBySession.values()) controller.abort();
	abortBySession.clear();
}

const defaultLoad = (): HerdrSettings =>
	loadSettings(getSettingsPaths(process.cwd())).effective;

/** Compose the run's single completion push from its result. */
function completionMessage(
	run: WorkflowRun,
	result: WorkflowRunResult,
	elapsedMs: number,
	notes: HerdrSettings["notifications"],
): SteeredMessage {
	const rows = result.progress.filter(
		(e): e is WorkflowAgentEntry => e.type === "workflow_agent",
	);
	const done = rows.filter((r) => r.state === "done").length;
	const failed = rows.filter((r) => r.state === "error").length;
	const logs = result.progress
		.filter((e) => e.type === "workflow_log")
		.map((e) => (e as { message: string }).message)
		.slice(-10);
	const elapsed = formatElapsed(elapsedMs);
	// A resume never quietly looks like a run that was simply fast — the count
	// rides every terminal status, not just the happy one.
	const replayed =
		result.replayedCount > 0
			? `, ${result.replayedCount} replayed from ${run.resumedFrom ?? "an earlier run"}`
			: "";

	let content: string;
	let wake: boolean;
	if (result.status === "completed") {
		const valueJson = safeJson(result.value);
		content =
			`Workflow "${run.meta.name}" finished — ${done}/${result.agentCount} agents${replayed} · ${elapsed}.\n` +
			`Return value: ${valueJson.length > RESULT_PREVIEW_LENGTH ? `${valueJson.slice(0, RESULT_PREVIEW_LENGTH)}…` : valueJson}\n` +
			`Script: ${run.scriptPath}`;
		wake = terminalWake(notes); // normal → wake; quiet → next turn; none → sink drops it
	} else if (result.status === "killed") {
		content = `Workflow "${run.meta.name}" was aborted (${done}/${result.agentCount} agents had finished${replayed}). Script: ${run.scriptPath}`;
		wake = true;
	} else {
		content =
			`Workflow "${run.meta.name}" FAILED after ${done}/${result.agentCount} agents (${failed} failed${replayed}, ${elapsed}): ${result.error ?? "unknown error"}\n` +
			`Script: ${run.scriptPath}`;
		wake = true; // failures always wake, like a failed child
	}
	if (logs.length > 0) {
		content += `\nLog:\n${logs.map((l) => `- ${l}`).join("\n")}`;
	}
	return { content, details: { kind: "workflow", runId: run.runId, status: result.status }, wake };
}

const safeJson = (v: unknown): string => {
	try {
		return JSON.stringify(v) ?? "undefined";
	} catch {
		return "unserializable";
	}
};

/** `45s` / `7m 12s` — coarse run-elapsed for the completion line. */
function formatElapsed(ms: number): string {
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	return `${Math.floor(s / 60)}m ${s % 60}s`;
}

/**
 * Resolve a `resumeFromRunId` against the runs this session has seen.
 *
 * PORTED from tintinweb/pi-subagents `src/workflow/task.ts` `resolveResumeTarget`
 * (MIT), adapted to this module's run registry. Same-session only, and
 * deliberately so: the journal lives beside this session's scratch files, and a
 * run id from another session would silently find nothing to replay — reporting
 * that as "resumed" would be a lie the caller could not see through. An unknown
 * id is an error rather than a cold start, because a caller that asked to resume
 * is expecting not to pay.
 */
export function resolveResumeTarget(
	runId: string | undefined,
): undefined | { ok: true; runId: string; journalPath: string; scriptPath: string } | { ok: false; message: string } {
	const id = runId?.trim();
	if (id === undefined || id === "") return undefined;

	const prior = runs.get(id);
	if (prior === undefined) {
		const known = [...runs.keys()];
		return {
			ok: false,
			message:
				`No workflow run "${id}" in this session. ` +
				(known.length > 0
					? `Runs this session: ${known.join(", ")}.`
					: "Nothing has run yet — call this without `resumeFromRunId`."),
		};
	}
	if (prior.status === "running") {
		return {
			ok: false,
			message: `Workflow "${id}" is still running. Stop it (kill switch / card action) before resuming it.`,
		};
	}
	return {
		ok: true,
		runId: id,
		journalPath: prior.journalPath,
		// The persisted copy, which is what `scriptPath` holds when the call had
		// no file of its own.
		scriptPath: prior.scriptPath,
	};
}
