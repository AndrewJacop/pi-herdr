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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	runWorkflow,
	validateScript,
	type WorkflowAgentEntry,
	type WorkflowEntry,
	type WorkflowRunResult,
} from "./runtime.js";
import type { WorkflowMeta } from "./meta.js";
import {
	appendJournal,
	readJournal,
	workflowScratchDir,
} from "./journal.js";
import { createWorkflowHost } from "./host.js";
import { isUnsafeName } from "./saved.js";
import { makeDeliverySink, terminalWake, type SteeredMessage } from "../push.js";
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
	endedAt?: number;
	result?: WorkflowRunResult;
	/** The append-only progress log, updated LIVE (issue 14) — the card and
	 * the widget's workflow row derive from this, not from `result`. */
	progress: WorkflowEntry[];
}

const runs = new Map<string, WorkflowRun>();

/** Live run snapshot (tests). */
export function workflowRuns(): ReadonlyMap<string, WorkflowRun> {
	return runs;
}

/** The runs still going (issue 14): the card and the widget's workflow row
 * render exactly these, and clear when the set is empty. */
export function liveWorkflowRuns(): ReadonlyMap<string, WorkflowRun> {
	return new Map([...runs].filter(([, run]) => run.status === "running"));
}

/**
 * Stop one live run (the kill-switch action, issue 14): abort its signal —
 * the runtime terminates the worker and closes every in-flight child
 * host-side (sessions retained). Already-settled or unknown ids are a no-op
 * returning false, so a double-click cannot double-report.
 */
export function stopWorkflowRun(runId: string): boolean {
	const controller = abortBySession.get(runId);
	if (controller === undefined) return false;
	controller.abort();
	return true;
}

/** `wf_` + hex — matches the resumeFromRunId shape issue 13 keys on. */
export function newWorkflowRunId(): string {
	return `wf_${randomBytes(6).toString("hex")}`;
}

/** The scratch directory moved to journal.ts (issue 14) so the host can use
 * it without a runs→host cycle; re-exported here for the tool + tests. */
export { workflowScratchDir } from "./journal.js";

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
	/** The run's working directory (manual e2e F15): where an inline script
	 * auto-saves (<cwd>/.pi/workflows/). Default: process.cwd(). */
	cwd?: string;
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
	// Manual e2e F15: an inline script persists to <cwd>/.pi/workflows/<name>.js
	// so a `name:` re-run resolves the same file — the temp scratch copy was
	// invisible to discovery. Identical target content → reuse; differing →
	// the first free -2/-3 suffix; unwritable cwd or unsafe name → the temp
	// scratch copy (below), which is what today's behavior already was.
	const savedPath =
		options.sourcePath === undefined
			? persistInlineScript(options.cwd ?? process.cwd(), meta.name, script)
			: undefined;
	if (savedPath === undefined) {
		const scriptPath = join(dir, `${runId}.workflow.js`);
		writeFileSync(scriptPath, script, "utf8");
	}
	// The journal stays run-id-keyed in the scratch dir beside every other
	// run's journal — what makes a run id enough to resume from (issue 13;
	// same-session only, like the run itself). Only the SCRIPT file moves.
	const journalPath = join(dir, `${runId}.workflow.jsonl`);

	const run: WorkflowRun = {
		runId,
		meta,
		...(options.sourcePath !== undefined
			? { scriptPath: options.sourcePath }
			: { scriptPath: savedPath ?? join(dir, `${runId}.workflow.js`) }),
		journalPath,
		...(options.resumeFrom !== undefined ? { resumedFrom: options.resumeFrom.runId } : {}),
		status: "running",
		startedAt: (options.now ?? (() => Date.now()))(),
		progress: [],
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
		// Live progress (issue 14): the card reads run.progress while the run
		// is going — result.progress only lands at settle.
		onProgress: (entries) => {
			run.progress.push(...entries);
		},
		journal: {
			...(replay.length > 0 ? { entries: replay } : {}),
			append: (entry) => appendJournal(journalPath, entry),
		},
	})
		.then((result): WorkflowRunResult => {
			const finishedAt = (options.now ?? (() => Date.now()))();
			run.status = result.status;
			run.endedAt = finishedAt;
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
 * Manual e2e F15: persist an inline script to `<cwd>/.pi/workflows/<name>.js`
 * so a `name:` re-run (same discovery order as ever) resolves the same file.
 * A target that exists with identical content is reused; one that differs
 * gets the first free `<name>-2.js`, `-3.js`… suffix. Unwritable cwd or an
 * unsafe name (path traversal, separators — same whitelist saved discovery
 * enforces) returns undefined and the run falls back to the temp scratch.
 */
function persistInlineScript(
	cwd: string,
	name: string,
	script: string,
): string | undefined {
	if (isUnsafeName(name)) return undefined;
	const dir = join(cwd, ".pi", "workflows");
	try {
		mkdirSync(dir, { recursive: true });
		for (let n = 1; ; n++) {
			const path = join(dir, n === 1 ? `${name}.js` : `${name}-${n}.js`);
			if (!existsSync(path)) {
				writeFileSync(path, script, "utf8");
				return path;
			}
			if (readFileSync(path, "utf8") === script) return path;
		}
	} catch {
		return undefined; // unwritable cwd → today's temp scratch copy
	}
}

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
	// Manual e2e F14: the summary is self-sufficient for diagnosis — every
	// failed agent's first-line reason rides the report, so a straggler notice
	// is never the only place a cause appears. Capped per reason.
	const failures = rows
		.filter((r) => r.state === "error")
		.map((r) => `${r.label}: ${failureReason(r.error)}`)
		.join("; ");
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
			`Workflow "${run.meta.name}" finished — ${done}/${result.agentCount} agents${replayed} · ${elapsed}` +
			(failures ? ` — failures: ${failures}` : "") +
			`.\n` +
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

/** First line of a failure reason, capped — the summary-line form (F14). */
function failureReason(error: unknown): string {
	const line = String(error ?? "unknown").split("\n", 1)[0].trim() || "unknown";
	return line.length > 120 ? `${line.slice(0, 119)}…` : line;
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
