/**
 * runtime.ts — the host half of a workflow run.
 *
 * PORTED from tintinweb/pi-subagents `src/workflow/runtime.ts` (MIT; clone at
 * `.scratch/pi-subagents/`, gitignored). Ported near-verbatim with four
 * pi-herdr trims, all decided by the v0.6 issue-12 ruling — provenance kept in
 * this header per the honesty ruling; see the README acknowledgement:
 *
 *   1. **No run control** — `WorkflowControl` (pause/skip/retry) belongs to
 *      the FleetView inspector, deferred post-v0.6; stopping a run is the
 *      kill-switch / card action (card = issue 14). Without control there are
 *      no skip/retry intents, so the journal has no skipped-call recording.
 *   2. **No schema** — structured output is issue 14's stretch; the worker
 *      names it as an unsupported option, and `journalKey` has no schema slot.
 *   3. **No separate pool** — `workflowConcurrency()` (cpus-derived) is not
 *      ported; the run's semaphore is `Infinity` and pacing flows through the
 *      ordinary spawn gates (cap/queue/kill-switch/depth). The Semaphore is
 *      kept as the mechanism; `Infinity` is the value. With nothing ever
 *      parked, upstream's replay-before-semaphore branch collapses into a
 *      replay at the top of {@link handleAgent}.
 *   4. **No token accounting** — `budget.spent()` reports honest `Infinity`;
 *      usage is not yet recoverable from the pi session substrate.
 *
 * Owns the worker lifecycle, the RPC bridge, the per-run caps, and the
 * progress log. The script's only route to an agent is a `call` message
 * landing here, which is what makes the caps and the abort story enforceable
 * at all: a script cannot go around them because it has nothing to go around
 * them *with*.
 *
 * Spawning is injected rather than imported. The herdr spawn engine is a
 * large, stateful dependency and wiring it in directly would make every test
 * here an integration test; a {@link WorkflowHost} stub is a dozen lines. The
 * adapter that binds this to herdr lives at `host.ts` (ours).
 */

import { Worker } from "node:worker_threads";
import { extractMeta, type WorkflowMeta } from "./meta.js";
import {
	type JournalKeyInput,
	journalKey,
	type WorkflowJournalEntry,
} from "./journal.js";
import { WORKER_SOURCE } from "./worker-source.js";
import { compileJsonSchema, type CompiledSchema } from "./json-schema.js";

/** Matches the `script` field's size check — 512 KiB. */
export const MAX_SCRIPT_LENGTH = 524_288;

/** Matches the `resumeFromRunId` field — `wf_` + lowercase id characters. */
export const RUN_ID_PATTERN = "^wf_[a-z0-9-]{6,}$";

/** Agents one run may schedule, in total. */
export const WORKFLOW_AGENT_CAP = 1000;

/** Items one `parallel()` or `pipeline()` call may take. */
export const WORKFLOW_ITEM_CAP = 4096;

/** Nested `workflow()` invocations allowed per run. */
export const WORKFLOW_NESTED_CAP = 256;

/** How much of a prompt or result is kept for the progress log. */
const PREVIEW_LENGTH = 200;

export class WorkflowRuntimeError extends Error {}

/**
 * ponytail: with `concurrency: Infinity` a 4096-item call creates 4096 queued
 * spawn records; herdr's queue drain paces the pane starts, but registry
 * iteration cost scales with it. Bound `concurrency` to max_parallel_agents in
 * runs.ts if a big fan-out is ever observed to hurt.
 */

/**
 * One agent the script asked for. `agentId` is the handle for
 * {@link WorkflowHost.abortAgent}.
 */
export interface WorkflowSpawnRequest {
	agentId: string;
	/** Position in the run, and the progress entry's stable identity. */
	index: number;
	prompt: string;
	label: string;
	agentType: string;
	model?: string;
	/**
	 * Reasoning effort for this child, as one of pi's thinking levels.
	 *
	 * Typed as a plain string because this interface is the host boundary and
	 * deliberately knows nothing about herdr — `host.ts` is where it becomes a
	 * `--thinking` flag. The worker has already rejected anything off the list.
	 */
	effort?: string;
	isolation?: "worktree";
	/**
	 * Called by the host once the child's EFFECTIVE configuration is known —
	 * which is when its launch plan is composed, not when the spawn resolves.
	 *
	 * Unused by the pi-herdr host in issue 12 (the progress rows are collected
	 * data, not a live card); kept because the progress fabric and issue 14's
	 * card build on it. Plain strings: this interface is the host boundary and
	 * deliberately knows nothing about pi.
	 */
	onResolved?(info: { recordId?: string; model?: string; thinking?: string }): void;
	/**
	 * The `gate` command this agent is being spawned under, when it has one.
	 */
	gate?: string;
	/**
	 * The compiled schema for a structured-output call (issue 14) — compiled
	 * runtime-side before anything spawns; the host registers the child-side
	 * `StructuredOutput` tool from it and re-checks the payload on settle.
	 */
	schema?: CompiledSchema;
}

export interface WorkflowSpawnResult {
	ok: boolean;
	/** The agent's answer. Present when `ok`. */
	text?: string;
	/** Why it failed. Present when not `ok`. */
	error?: string;
	/** The user dismissed it rather than it failing; renders as skipped. */
	skipped?: boolean;
	/** Lifetime output tokens from the child's session JSONL (issue 14).
	 * Absent = unrecoverable — the run's `budget.spent()` turns honest
	 * `Infinity` rather than sum a number that understates the truth. */
	outputTokens?: number;
	/** Completed tool calls, for the card row. */
	toolCalls?: number;
}

/** Outcome of a `gate` command. `output` is what the user is shown when it fails. */
export interface WorkflowGateResult {
	ok: boolean;
	/** Combined stdout/stderr, or whatever the host wants surfaced as the failure. */
	output: string;
}

/** How a script names another workflow: a saved name, or a path to a file. */
export interface WorkflowScriptRef {
	name?: string;
	scriptPath?: string;
}

export type WorkflowScriptSource =
	| { ok: true; script: string; path?: string }
	| { ok: false; message: string };

/** The one seam between a workflow and the rest of the extension. */
export interface WorkflowHost {
	spawnAgent(request: WorkflowSpawnRequest): Promise<WorkflowSpawnResult>;
	/** Called for every in-flight agent when the run aborts. */
	abortAgent(agentId: string): void;
	/**
	 * Continue a child that already ran in this run, keeping its context.
	 *
	 * `agentId` is one previously handed out in a {@link WorkflowSpawnRequest};
	 * the child keeps the agent type, model and tool contract it started with,
	 * so only the follow-up prompt crosses.
	 *
	 * Optional: a host without it rejects `resume` rather than quietly starting
	 * a fresh child that has none of the context the script is counting on.
	 */
	resumeAgent?(
		agentId: string,
		prompt: string,
		onResolved?: WorkflowSpawnRequest["onResolved"],
	): Promise<WorkflowSpawnResult>;
	/**
	 * Run a `gate` command and report whether it passed.
	 *
	 * `cwd` is the child's worktree when it had one. Optional for the same
	 * reason as `resumeAgent`, and more sharply: a gate that silently does not
	 * run would mark unverified work as verified, so the runtime fails the call
	 * instead of skipping it.
	 */
	runGate?(
		command: string,
		options: { agentId: string; cwd?: string },
	): Promise<WorkflowGateResult>;
	/**
	 * Resolve a nested `workflow()` reference to source.
	 *
	 * The runtime knows nothing about the filesystem or about pi, so it asks.
	 * It still decides whether what comes back *is* a workflow — see
	 * {@link validateScript} — because those rules belong with the runtime that
	 * enforces them everywhere else.
	 *
	 * Optional for the same reason as `resumeAgent`: a host without it rejects
	 * `workflow()` outright rather than silently running nothing. (pi-herdr
	 * issue 12 ships without it — resolution is issue 13's port.)
	 */
	loadWorkflow?(
		ref: WorkflowScriptRef,
	): Promise<WorkflowScriptSource> | WorkflowScriptSource;
}

export interface RunWorkflowOptions {
	/** Full script source, starting with `export const meta = { … }`. */
	script: string;
	args?: unknown;
	host: WorkflowHost;
	signal?: AbortSignal;
	/** Fired per batch, not per entry — see the worker's progress batching. */
	onProgress?(entries: readonly WorkflowEntry[]): void;
	/** In-flight cap. pi-herdr: `Infinity` — no separate pool (issue 12). */
	concurrency?: number;
	agentCap?: number;
	itemCap?: number;
	/**
	 * How many nested `workflow()` invocations one run may make in total.
	 *
	 * Each costs a compile and a scope rather than a thread, so the ceiling is
	 * generous — but unbounded is worse than capped, on the same reasoning as
	 * {@link agentCap}.
	 */
	nestedCap?: number;
	/**
	 * Replay and record, for `resumeFromRunId` (issue 13).
	 *
	 * The runtime does no file IO — `entries` come in already read and `append`
	 * goes back out — so its tests stay free of a filesystem, the same reason
	 * spawning is behind {@link WorkflowHost}.
	 */
	journal?: {
		/** A previous run's settled calls, in position order. Empty replays nothing. */
		entries?: readonly WorkflowJournalEntry[];
		/** Called as each call of *this* run settles, so it can be resumed in turn. */
		append?(entry: WorkflowJournalEntry): void;
	};
}

export interface WorkflowRunResult {
	status: "completed" | "failed" | "killed";
	meta: WorkflowMeta;
	/** The script's return value, JSON-checked at the boundary. */
	value?: unknown;
	error?: string;
	/** The append-only log, in emission order. */
	progress: WorkflowEntry[];
	/** Agents scheduled, including those that failed. */
	agentCount: number;
	/** How many of those came back from the journal instead of being spawned. */
	replayedCount: number;
}

/* ------------------------------------------------------------------------- *
 * Progress entries — PORTED to `progress.ts` (issue 14): the append-only log
 * types now live with the collapse/derivation model that reads them.
 * ------------------------------------------------------------------------- */

import type {
	WorkflowAgentEntry,
	WorkflowEntry,
	WorkflowLogEntry,
} from "./progress.js";

export type {
	WorkflowAgentEntry,
	WorkflowEntry,
	WorkflowLogEntry,
	WorkflowPhaseEntry,
} from "./progress.js";

/* ------------------------------------------------------------------------- *
 * JSON boundary — host side
 * ------------------------------------------------------------------------- */

function boundaryError(what: string, path: string): WorkflowRuntimeError {
	return new WorkflowRuntimeError(
		`Cannot pass ${what} across the workflow VM boundary (at ${path}).`,
	);
}

function walk(value: unknown, path: string, seen: Set<object>): void {
	if (value === null) return;
	const kind = typeof value;
	if (kind === "string" || kind === "boolean") return;
	if (kind === "number") {
		if (!Number.isFinite(value)) throw boundaryError("a non-finite number", path);
		return;
	}
	if (kind === "undefined") {
		if (path === "args") return;
		throw boundaryError("undefined", path);
	}
	if (kind === "bigint") throw boundaryError("a BigInt", path);
	if (kind === "symbol") throw boundaryError("a symbol", path);
	if (kind === "function") throw boundaryError("a function", path);
	if (kind !== "object") throw boundaryError(`a ${kind}`, path);

	const object = value as object;
	if (seen.has(object)) throw boundaryError("a circular structure", path);
	seen.add(object);

	if (Object.getOwnPropertySymbols(object).length > 0) {
		throw boundaryError("an object with symbol keys", path);
	}

	if (Array.isArray(object)) {
		for (let i = 0; i < object.length; i++) {
			if (!Object.hasOwn(object, i)) throw boundaryError("a sparse array", `${path}[${i}]`);
			walk(object[i], `${path}[${i}]`, seen);
		}
		seen.delete(object);
		return;
	}

	const prototype = Object.getPrototypeOf(object);
	if (prototype !== null && prototype !== Object.prototype) {
		throw boundaryError("a non-plain object", path);
	}
	for (const [key, entry] of Object.entries(object)) {
		walk(entry, `${path}.${key}`, seen);
	}
	seen.delete(object);
}

/**
 * Reject anything that cannot survive the round trip to the worker and into a
 * resume journal. Structured clone would happily carry a `Map` or a cycle that
 * the journal then cannot represent, so the check is stricter than the
 * transport.
 */
export function assertBoundarySafe(value: unknown, path: string): void {
	walk(value, path, new Set());
}

/* ------------------------------------------------------------------------- *
 * Semaphore
 * ------------------------------------------------------------------------- */

class Semaphore {
	private active = 0;
	private readonly waiters: (() => void)[] = [];

	constructor(private readonly limit: number) {}

	acquire(): Promise<void> {
		if (this.active < this.limit) {
			this.active++;
			return Promise.resolve();
		}
		return new Promise<void>((resolve) => {
			this.waiters.push(resolve);
		});
	}

	release(): void {
		const next = this.waiters.shift();
		// Hand the permit straight over rather than decrementing and re-acquiring;
		// otherwise a burst of releases can let more than `limit` through.
		if (next) next();
		else this.active--;
	}

	/** Wake everyone so aborted callers can observe the abort and bail. */
	drain(): void {
		while (this.waiters.length > 0) {
			const next = this.waiters.shift();
			next?.();
		}
	}
}

/* ------------------------------------------------------------------------- *
 * Messages
 * ------------------------------------------------------------------------- */

interface AgentCallPayload {
	prompt: string;
	label?: string;
	model?: string;
	agentType?: string;
	isolation?: "worktree";
	phaseIndex?: number;
	phaseTitle?: string;
	/** Shell command that has to pass before the agent counts as done. */
	gate?: string;
	/** Label of an earlier child in this run to continue instead of starting one. */
	resume?: string;
	/** Reasoning effort, already validated against pi's thinking levels worker-side. */
	effort?: string;
	/** Raw JSON Schema from `agent({ schema })`, compiled before anything spawns. */
	schema?: unknown;
}

type WorkerMessage =
	| { type: "call"; callId: number; method: string; payload: AgentCallPayload | WorkflowScriptRef }
	| { type: "progress"; entries: WorkflowEntry[] }
	| { type: "complete"; resultJson?: string }
	| { type: "error"; message: string; stack?: string };

/** Everything below 0x20 except tab, newline and carriage return, plus DEL. */
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

const preview = (text: string) =>
	text.length <= PREVIEW_LENGTH ? text : `${text.slice(0, PREVIEW_LENGTH - 1)}…`;

/** First line of the prompt, trimmed — the fallback display name for an agent. */
function derivedLabel(prompt: string): string {
	const line = prompt.split("\n", 1)[0].trim();
	return line.length <= 60 ? line || "agent" : `${line.slice(0, 59)}…`;
}

/**
 * A child `resume` can revive, remembered under its label.
 *
 * The spawn options travel with it because `resume` deliberately takes none: the
 * revived child keeps the agent type, model and isolation it was started with,
 * and the progress entry has to show the same thing the first entry showed.
 */
interface CompletedChild {
	agentId: string;
	label: string;
	agentType: string;
	model?: string;
	isolation?: "worktree";
}

/**
 * Hold a schema'd result to its schema, runtime-side.
 *
 * PORTED from upstream (MIT). The child's own StructuredOutput tool already
 * validated whatever it captured, so this normally agrees. It exists for the
 * cases where nothing did: a host that ignores `schema` entirely, a replayed
 * journal entry from before the schema changed, or a payload that reached us
 * some other way. The script asked for a shape; exactly one place should be
 * able to promise it.
 */
function applySchema(result: WorkflowSpawnResult, compiled: CompiledSchema): WorkflowSpawnResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(result.text ?? "");
	} catch {
		return {
			...result,
			ok: false,
			error: "The agent did not return structured output: its answer was not JSON.",
		};
	}
	const verdict = compiled.check(parsed);
	if (verdict === true) return result;
	return {
		...result,
		ok: false,
		error: `The agent's answer did not match the requested schema: ${verdict}`,
	};
}

/**
 * Turn a failing gate into a failing agent.
 *
 * Deliberately no new state, no new entry type: a gated agent whose command
 * fails is *a failed agent*, so the card, the dialog and `agent()`'s `null`
 * return all handle it with the code they already have. The command output
 * becomes the error, because that is the thing worth reading.
 *
 * The single place that decides whether a gate passed. (pi-herdr: there is no
 * host-ran-inside-settle route — herdr worktrees persist past the child, so
 * `runGate` is always the executor.)
 */
async function applyGate(
	result: WorkflowSpawnResult,
	command: string,
	agentId: string,
	runGate: NonNullable<WorkflowHost["runGate"]>,
): Promise<WorkflowSpawnResult> {
	const outcome = await runGate(command, { agentId });
	if (outcome.ok) return result;
	const { text: _discarded, ...rest } = result;
	const output = outcome.output.trim();
	return {
		...rest,
		ok: false,
		error: output === "" ? `Gate command failed: ${command}` : output,
	};
}

/**
 * Nico's wording, kept verbatim — this is the one borrowed check whose message a
 * user is likely to search for.
 */
function unawaitedLaunchMessage(labels: readonly string[]): string {
	const list = labels.map((label) => `'${label}'`).join(", ");
	return `workflow script completed with unawaited agent launch(es): ${list}. Await or return each launch.`;
}

/**
 * Everything a script must satisfy before it is compiled.
 *
 * Extracted so a nested `workflow()` is held to exactly the same standard as a
 * top-level run: same size limit, same character rules, same `meta` contract.
 * The host resolves a reference to source; deciding whether that source is a
 * workflow stays here, where the rules live.
 */
export function validateScript(script: string): { meta: WorkflowMeta; body: string } {
	if (script.length > MAX_SCRIPT_LENGTH) {
		throw new WorkflowRuntimeError(
			`Workflow script is ${script.length} characters, over the limit of ${MAX_SCRIPT_LENGTH}.`,
		);
	}
	if (CONTROL_CHARACTERS.test(script)) {
		throw new WorkflowRuntimeError(
			"Workflow script contains control characters. Only tab, carriage return and newline are allowed.",
		);
	}
	return extractMeta(script);
}

/**
 * Run one workflow script to completion.
 *
 * Rejects before starting for a script that cannot run at all (bad `meta`, over
 * the size limit, control characters, non-JSON `args`). Everything after the
 * worker is live resolves instead, carrying the failure in `status` — by then
 * there is a progress log worth handing back.
 */
export async function runWorkflow(options: RunWorkflowOptions): Promise<WorkflowRunResult> {
	const { script, host } = options;

	assertBoundarySafe(options.args, "args");

	const { meta, body } = validateScript(script);
	const agentCap = options.agentCap ?? WORKFLOW_AGENT_CAP;
	const itemCap = options.itemCap ?? WORKFLOW_ITEM_CAP;
	// No separate pool (issue 12): the semaphore is unbounded by default and
	// pacing flows through herdr's ordinary spawn gates (cap/queue/kill-switch).
	const semaphore = new Semaphore(options.concurrency ?? Number.POSITIVE_INFINITY);

	const progress: WorkflowEntry[] = [];
	const inflight = new Set<string>();
	/** Label → the child that ran under it, last one wins. The `resume` handle. */
	const completedByLabel = new Map<string, CompletedChild>();
	/**
	 * Launches the host has accepted and not yet answered, in call order.
	 *
	 * This is the whole unawaited-launch mechanism: a script that drops an
	 * `agent()` promise still gets its call answered eventually, but it returns
	 * first — so anything left here when `complete` arrives is a result nobody
	 * is waiting for. Tracking it host-side avoids proxying `Promise` inside the
	 * realm, which rules out, and reading stack traces, which is brittle.
	 */
	const openLaunches = new Map<number, string>();
	let agentCount = 0;
	let settled = false;

	/* --- budget.spent() (issue 14) --------------------------------------- */

	/**
	 * Output tokens this run has spent, mirrored to the script as
	 * `budget.spent()`. The host owns the number and every response carries
	 * it (upstream's pattern): two counters would drift, and the script only
	 * learns anything through agent responses, so there is no observable
	 * staleness to worry about.
	 *
	 * pi-herdr's honesty rule: usage is recovered from the child's session
	 * JSONL; ONE child without recoverable usage makes the whole tally
	 * unknown (`Infinity`) — a sum that understates spend is the lie a
	 * budget-gated script would overspend on. Replayed (journal) calls spent
	 * nothing this run and never poison.
	 */
	let spentKnown = 0;
	let spentUnknown = false;
	const spent = () => (spentUnknown ? Number.POSITIVE_INFINITY : spentKnown);

	/* --- resume journal (issue 13) --------------------------------------- */

	const journalEntries = options.journal?.entries ?? [];
	const recordJournal = options.journal?.append;
	/**
	 * Whether the replayable prefix is still intact.
	 *
	 * Once a position misses — different key, a journaled failure, or nothing
	 * recorded there — every later call runs live, however well it matches.
	 * See the header of journal.ts for why this is a prefix and not a lookup.
	 */
	// A journal from a run that used `agent({ resume })` is declined whole: see
	// journal.ts on why a replayed agent leaves nothing for a later resume to
	// continue. Declining up front beats stranding the first `resume` call
	// partway through a run that has already spent its cheap half.
	const journalResumes = journalEntries.some((entry) => entry.resumed);
	let prefixIntact = journalEntries.length > 0 && !journalResumes;
	let replayedCount = 0;

	/** The journal entry to reuse at `index`, or undefined to run it live. */
	function replayAt(index: number, key: string): WorkflowJournalEntry | undefined {
		if (!prefixIntact) return undefined;
		const entry = journalEntries[index];
		if (entry === undefined || entry.index !== index || entry.key !== key || !entry.ok) {
			prefixIntact = false;
			return undefined;
		}
		return entry;
	}

	const worker = new Worker(WORKER_SOURCE, {
		eval: true,
		workerData: {
			body,
			metaJson: JSON.stringify(meta),
			argsJson: options.args === undefined ? undefined : JSON.stringify(options.args),
			itemCap,
			nestedCap: options.nestedCap ?? WORKFLOW_NESTED_CAP,
		},
	});

	return await new Promise<WorkflowRunResult>((resolve) => {
		const emit = (entries: WorkflowEntry[]) => {
			if (entries.length === 0) return;
			progress.push(...entries);
			options.onProgress?.(entries);
		};

		const respond = (
			callId: number,
			ok: boolean,
			value?: unknown,
			error?: string,
			fatal?: boolean,
		) => {
			// Cleared before the settled check: a launch answered by a run that is
			// already finishing is not an unawaited launch either.
			openLaunches.delete(callId);
			if (settled) return;
			// `spent` rides on every response, so the worker's `budget.spent()` is
			// a mirror of this number rather than a second tally of its own.
			worker.postMessage({ type: "response", callId, ok, value, error, fatal, spent: spent() });
		};

		const finish = (
			result: Omit<WorkflowRunResult, "meta" | "progress" | "agentCount" | "replayedCount">,
		) => {
			if (settled) return;
			settled = true;
			options.signal?.removeEventListener("abort", onAbort);
			// Wake everything parked on the semaphore so it observes the settle and
			// unwinds. Nothing depends on it — the run's promise resolves either
			// way — it just does not leave live bookkeeping behind for a run that
			// is over.
			for (const agentId of inflight) host.abortAgent(agentId);
			inflight.clear();
			semaphore.drain();
			// Resolve only once the thread is actually down, so a caller that
			// awaits runWorkflow() is guaranteed not to be leaking one.
			const settle = () => resolve({ ...result, meta, progress, agentCount, replayedCount });
			void worker.terminate().then(settle, settle);
		};

		function onAbort() {
			// terminate() is why this runs in a worker at all: it stops a script that
			// is spinning or wedged mid-await, which an in-process vm cannot do.
			finish({ status: "killed", error: "Workflow aborted." });
		}

		if (options.signal) {
			if (options.signal.aborted) {
				onAbort();
				return;
			}
			options.signal.addEventListener("abort", onAbort, { once: true });
		}

		async function handleAgent(callId: number, payload: AgentCallPayload): Promise<void> {
			// Bound now: the optional methods are checked once, up front, so a
			// capability the host lacks fails before an agent is spawned rather
			// than after — a gate that never ran must not be mistaken for a gate
			// that passed.
			const runGate = host.runGate?.bind(host);
			const resumeAgent = host.resumeAgent?.bind(host);
			if (payload.gate !== undefined && runGate === undefined) {
				respond(callId, false, undefined, "This workflow host cannot run gate commands.", true);
				return;
			}
			if (payload.resume !== undefined && resumeAgent === undefined) {
				respond(callId, false, undefined, "This workflow host cannot resume agents.", true);
				return;
			}

			let resumed: CompletedChild | undefined;
			if (payload.resume !== undefined) {
				resumed = completedByLabel.get(payload.resume);
				if (resumed === undefined) {
					const known = [...completedByLabel.keys()];
					// Fatal: a typo'd label is a script bug, and folding it into a null
					// would show up as an agent that mysteriously returned nothing.
					//
					// Unless agents were replayed, in which case it is not a script bug
					// at all — the label's child came back from the journal and has no
					// conversation here to continue. Saying "no agent has completed"
					// would send the reader hunting for a typo that is not there.
					respond(
						callId,
						false,
						undefined,
						replayedCount > 0
							? `agent() opts.resume: "${payload.resume}" was replayed from the resume journal, not run, so there is ` +
								"no conversation in this run to continue. Re-run without resumeFromRunId."
							: `agent() opts.resume: no agent has completed under the label "${payload.resume}" in this run. ${
									known.length === 0
										? "No agent has completed yet."
										: `Known labels: ${known.map((label) => `"${label}"`).join(", ")}.`
								  }`,
						true,
					);
					return;
				}
			}

			// Compiled before anything is scheduled. A schema the runtime cannot use
			// is a script bug, so it is fatal like a typo'd resume label — folding it
			// into a null would surface as an agent that mysteriously returned
			// nothing, and it costs no model call to say so here.
			let compiledSchema: CompiledSchema | undefined;
			if (payload.schema !== undefined) {
				const compilation = compileJsonSchema(payload.schema);
				if (!compilation.ok) {
					respond(callId, false, undefined, compilation.message, true);
					return;
				}
				compiledSchema = compilation.compiled;
			}

			if (agentCount >= agentCap) {
				// Fatal, so parallel()/pipeline() rethrow instead of folding it into a
				// null. A cap that silently drops work is worse than no cap.
				respond(callId, false, undefined, `Workflow exceeded its cap of ${agentCap} agents.`, true);
				return;
			}
			const index = agentCount++;
			// A resumed call is the same child again: it keeps the agent id, so an
			// abort still reaches it, and it keeps its spawn contract, so the row
			// reads the same as the row it continues.
			const agentId = resumed?.agentId ?? `wf-agent-${index}`;
			const label = payload.label ?? resumed?.label ?? derivedLabel(payload.prompt);
			const agentType = resumed?.agentType ?? payload.agentType ?? "general-purpose";
			const model = resumed !== undefined ? resumed.model : payload.model;
			const isolation = resumed !== undefined ? resumed.isolation : payload.isolation;
			openLaunches.set(callId, label);

			const base: WorkflowAgentEntry = {
				type: "workflow_agent",
				index,
				label,
				state: "start",
				agentId,
				agentType,
				promptPreview: preview(payload.prompt),
				...(model !== undefined ? { model } : {}),
				...(isolation !== undefined ? { isolation } : {}),
				...(payload.phaseIndex !== undefined ? { phaseIndex: payload.phaseIndex } : {}),
				...(payload.phaseTitle !== undefined ? { phaseTitle: payload.phaseTitle } : {}),
			};

			const queuedAt = Date.now();
			emit([{ ...base, queuedAt }]);

			// The payload decides the journal key: everything that changes what the
			// agent does, and nothing that only moves its row around the tree.
			// The schema is the raw object; the key wants it serialized, so the
			// spread is narrowed rather than passed through.
			const keyInput: JournalKeyInput = {
				prompt: payload.prompt,
				...(payload.label !== undefined ? { label: payload.label } : {}),
				...(payload.model !== undefined ? { model: payload.model } : {}),
				...(payload.agentType !== undefined ? { agentType: payload.agentType } : {}),
				...(payload.effort !== undefined ? { effort: payload.effort } : {}),
				...(payload.isolation !== undefined ? { isolation: payload.isolation } : {}),
				...(payload.gate !== undefined ? { gate: payload.gate } : {}),
				...(payload.resume !== undefined ? { resume: payload.resume } : {}),
				...(payload.schema !== undefined ? { schema: JSON.stringify(payload.schema) } : {}),
			};
			const key = journalKey(keyInput);
			// Replay before the child is registered in-flight: a cached answer is
			// not a child, so there is nothing to abort and no slot it holds. The
			// row still appears in the progress log — the run reads as the same
			// shape it had the first time, just faster.
			// A replayed answer still has to satisfy the schema. The key covers a
			// schema that *changed*, but not a journal that was hand-edited, and
			// not the empty text a torn entry leaves behind — either would hand
			// the script a null from an entry the journal claims succeeded.
			let replayed = replayAt(index, key);
			if (replayed !== undefined && compiledSchema !== undefined) {
				const recheck = applySchema({ ok: true, text: replayed.text ?? "" }, compiledSchema);
				if (!recheck.ok) {
					prefixIntact = false;
					replayed = undefined;
				}
			}
			if (replayed !== undefined) {
				replayedCount++;
				const replayedText = replayed.text ?? "";
				const at = Date.now();
				emit([
					{
						...base,
						queuedAt,
						startedAt: at,
						lastProgressAt: at,
						durationMs: 0,
						state: "done",
						// The row reads as done, because it is — `cached` is what tells
						// issue 14's card to annotate it "from resume journal" rather
						// than letting a 0ms agent look like one that did the work
						// impossibly fast.
						cached: true,
						resultPreview: preview(replayedText),
					},
				]);
				openLaunches.delete(callId);
				// Re-recorded so this run's journal is complete on its own terms: a
				// resume of a resume must not have to walk back through a chain of
				// earlier files to find the prefix.
				recordJournal?.({ index, key: replayed.key, ok: true, text: replayedText });
				respond(callId, true, replayedText);
				return;
			}
			const resumeMark = payload.resume !== undefined ? ({ resumed: true } as const) : {};

			const startedAt = Date.now();
			emit([{ ...base, queuedAt, startedAt }]);

			// Mutates `base` rather than emitting a standalone patch: every later
			// emit spreads it, so the settle path carries the effective values
			// without knowing they were ever corrected. Re-emitting under the same
			// `index` is what the append-only, last-write-wins progress log is for.
			const onResolved = (info: { recordId?: string; model?: string; thinking?: string }) => {
				if (info.recordId !== undefined) (base as { recordId?: string }).recordId = info.recordId;
				if (info.model !== undefined) base.model = info.model;
				if (info.thinking !== undefined) (base as { thinking?: string }).thinking = info.thinking;
				if (!inflight.has(agentId)) return;
				emit([{ ...base, queuedAt, startedAt, lastProgressAt: Date.now() }]);
			};
			inflight.add(agentId);

			let result: WorkflowSpawnResult;
			try {
				result =
					resumed !== undefined && resumeAgent !== undefined
						? await resumeAgent(resumed.agentId, payload.prompt, onResolved)
						: await host.spawnAgent({
								agentId,
								index,
								prompt: payload.prompt,
								label,
								agentType,
								...(model !== undefined ? { model } : {}),
								...(payload.effort !== undefined ? { effort: payload.effort } : {}),
								...(isolation !== undefined ? { isolation } : {}),
								...(payload.phaseIndex !== undefined ? { phaseIndex: payload.phaseIndex } : {}),
								...(payload.phaseTitle !== undefined ? { phaseTitle: payload.phaseTitle } : {}),
								...(payload.gate !== undefined ? { gate: payload.gate } : {}),
								...(compiledSchema !== undefined ? { schema: compiledSchema } : {}),
								onResolved,
							});
				if (result.ok) {
					// Recorded before the gate runs: the child itself finished, so it is
					// resumable even when its gate rejects the work — "here is what the
					// gate said, fix it" is the loop this exists for.
					completedByLabel.set(label, {
						agentId,
						label,
						agentType,
						...(model !== undefined ? { model } : {}),
						...(isolation !== undefined ? { isolation } : {}),
					});
					// Re-checked here, not just in the child's tool: this is the one
					// place that decides the script's value matches the schema it
					// asked for, so a host that ignored `schema` fails loudly instead
					// of handing the script prose. Before the gate, because a gate
					// verifies work and there is no work to verify if the shape is
					// wrong — and the reader should see the schema error, not a gate
					// error standing in front of it.
					if (compiledSchema !== undefined) {
						result = applySchema(result, compiledSchema);
					}
					if (result.ok && payload.gate !== undefined && runGate !== undefined) {
						result = await applyGate(result, payload.gate, agentId, runGate);
					}
				}
			} catch (error) {
				result = { ok: false, error: error instanceof Error ? error.message : String(error) };
			} finally {
				inflight.delete(agentId);
			}

			if (settled) return;

			const finishedAt = Date.now();
			const common = {
				...base,
				queuedAt,
				startedAt,
				lastProgressAt: finishedAt,
				durationMs: finishedAt - startedAt,
			};

			// Counted before either settle branch responds, so the very call that
			// spent them already sees them in `budget.spent()`. A child whose usage
			// never landed in a readable session file poisons the tally — a number
			// that understates spend is worse than an honest unknown. Failed
			// agents burned tokens either way (upstream's ruling).
			if (result.outputTokens === undefined) spentUnknown = true;
			else spentKnown += result.outputTokens;

			if (result.ok) {
				const text = result.text ?? "";
				emit([
					{
						...common,
						state: "done",
						resultPreview: preview(text),
						...(result.toolCalls !== undefined ? { toolCalls: result.toolCalls } : {}),
					},
				]);
				recordJournal?.({ index, key, ok: true, text, ...resumeMark });
				respond(callId, true, text);
				return;
			}
			// Recorded as a failure rather than left out: a gap would be read as an
			// unchanged prefix on the next resume, silently skipping the retry this
			// whole mechanism exists to make cheap.
			recordJournal?.({ index, key, ok: false, ...resumeMark });
			emit([
				{
					...common,
					state: "error",
					error: result.error ?? "Agent failed.",
					...(result.skipped ? { skipped: true } : {}),
					...(result.toolCalls !== undefined ? { toolCalls: result.toolCalls } : {}),
				},
			]);
			respond(callId, true, null);
		}

		/**
		 * Resolve one `workflow(ref)` and hand the child's source back compiled.
		 *
		 * Resolution failures are non-fatal — Claude Code documents `workflow()` as
		 * throwing on an unknown name so a script can catch it and carry on. A host
		 * with no `loadWorkflow` at all is fatal, matching how a missing `runGate`
		 * or `resumeAgent` is treated: a capability the script asked for and this
		 * host cannot provide is a wiring error, not a runtime condition.
		 * (pi-herdr issue 12 ships without it — resolution is issue 13's port.)
		 */
		async function handleLoadWorkflow(callId: number, ref: WorkflowScriptRef): Promise<void> {
			const loadWorkflow = host.loadWorkflow?.bind(host);
			if (loadWorkflow === undefined) {
				respond(
					callId,
					false,
					undefined,
					"This workflow host cannot run nested workflows — saved-workflow resolution arrives with pi-herdr v0.6 issue 13.",
					true,
				);
				return;
			}
			let source: WorkflowScriptSource;
			try {
				source = await loadWorkflow(ref);
			} catch (error) {
				respond(callId, false, undefined, error instanceof Error ? error.message : String(error));
				return;
			}
			if (!source.ok) {
				respond(callId, false, undefined, source.message);
				return;
			}
			try {
				const child = validateScript(source.script);
				respond(callId, true, {
					name: child.meta.name,
					metaJson: JSON.stringify(child.meta),
					body: child.body,
				});
			} catch (error) {
				respond(callId, false, undefined, error instanceof Error ? error.message : String(error));
			}
		}

		worker.on("message", (message: WorkerMessage) => {
			if (settled) return;
			switch (message.type) {
				case "progress":
					emit(message.entries);
					break;
				case "call":
					if (message.method === "workflow") {
						void handleLoadWorkflow(message.callId, message.payload as WorkflowScriptRef);
						break;
					}
					if (message.method !== "agent") {
						respond(message.callId, false, undefined, `Unknown workflow host method "${message.method}".`, true);
						break;
					}
					void handleAgent(message.callId, message.payload as AgentCallPayload);
					break;
				case "complete": {
					// The script is done, so every launch it made should have been
					// answered by now — a response is sent before the worker can post
					// this, so anything still open was never awaited. finish() aborts
					// those children on the way out.
					const unawaited = [...openLaunches.values()];
					if (unawaited.length > 0) {
						finish({ status: "failed", error: unawaitedLaunchMessage(unawaited) });
						break;
					}
					// The result crossed the boundary as JSON the worker checked before
					// sending; a value that still fails to parse is a broken worker, and
					// the run fails honestly rather than throwing out of this handler.
					let value: unknown;
					if (message.resultJson !== undefined) {
						try {
							value = JSON.parse(message.resultJson);
						} catch (error) {
							finish({
								status: "failed",
								error: `The workflow result did not survive the worker boundary: ${error instanceof Error ? error.message : String(error)}`,
							});
							break;
						}
					}
					finish({
						status: "completed",
						...(message.resultJson === undefined ? {} : { value }),
					});
					break;
				}
				case "error":
					finish({ status: "failed", error: message.message });
					break;
			}
		});

		worker.on("error", (error) => {
			finish({ status: "failed", error: error instanceof Error ? error.message : String(error) });
		});

		worker.on("exit", () => {
			// Only reachable when the worker dies without reporting — a terminate()
			// we did not initiate, or a hard crash.
			finish({ status: "failed", error: "Workflow worker exited before completing." });
		});
	});
}
