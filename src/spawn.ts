// The spawn_agent engine: gates, spec merge, per-kind enforcement, the
// session spawn registry, the over-cap queue, and the wait vocabulary.
//
// Decided by wayfinder ticket 01 — spawn_agent surface:
//   - gates checked IN ORDER before any pane/worktree side effect:
//     kill-switch → spawn depth → parallel cap (cap hit = queued, not refused);
//   - `kind`/`model` merge over the definition (definition < spawn param) and
//     the MERGED spec is validated once, enforce-or-error per kind — a field
//     the kind cannot enforce errors naming the field, pointing at agent_args;
//   - `name` is the pane handle with a fallback chain:
//     spawn name → definition name → agent-<timestamp>, uniquified when taken;
//   - `isolated: true` = herdr-side worktree (auto branch+path, no knobs),
//     child cwd = worktree path, pane in the current workspace;
//   - background by default; `wait: true` = until done-or-blocked,
//     `wait: ms` = current state on expiry; queued spawns wait through the
//     queue (ticket 03 — settings menu, decision 4);
//   - children carry PI_HERDR_SPAWN_DEPTH (incremented) and
//     PI_HERDR_ORCHESTRATOR_PANE (ticket 11: the spawning pane's
//     HERDR_PANE_ID — set only when this session itself runs in a pane).
//   - no layout params (charter item 2): split/tab/workspace stay behind
//     `surface: "full"` (herdr_start_agent).
//
// Ticket 11's pi-only scope ruling: `kind` is an unopinionated passthrough
// onto herdr's native `agent start --kind` axis. A non-pi child is text in a
// pane with a TUI-detected lifecycle, nothing else — hence the strict
// capability table below (verified in wayfinder/research/capability-matrix.md).

import { getAgentKinds } from "./config.js";
import { herdr } from "./herdr.js";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Err,
	type HerdrErrorCode,
	normalizeAgent,
	type Result,
} from "./env.js";
import {
	getSettingsPaths,
	loadSettings,
	type HerdrSettings,
} from "./settings.js";
import {
	registerSessionAgent,
	resolveSpecifier,
	type AgentDefinition,
} from "./agentdefs.js";

// The agent-definition API future tickets and tests consume THROUGH this
// module: jiti-based tests importing src/agentdefs.ts directly would get a
// separate module instance (mutable session state must have ONE home), and
// get_agent_result / message_agent will layer on spawn-engine state anyway.
export {
	BUILT_IN_AGENTS,
	clearSessionAgents,
	listAgentTypes,
	registerSessionAgent,
	resolveAgentType,
	resolveSpecifier,
} from "./agentdefs.js";
import {
	getAgentStatus,
	kindError,
	startHerdrAgent,
	submitAndWait,
	waitForStatus,
} from "./tools/orchestration.js";
import { createWorktreeArgs, extractWorktree } from "./tools/worktrees.js";

// ---- status vocabulary --------------------------------------------------------
// Ticket 10 — six states, shared with get_agent_result later in v0.5:
// queued | working | idle | done | blocked | gone.
// `done` = idle with an unconsumed result; here it is derived from
// submitted-then-settled (the spawn just submitted the prompt, so any settled
// idle/done has an unconsumed result).

export type SpawnStatus =
	| "queued"
	| "working"
	| "idle"
	| "done"
	| "blocked"
	| "gone";

// ---- pure helpers (unit-tested offline) ---------------------------------------

/** Build a non-ok Result with a normalized error code. */
export function spawnErr(
	code: HerdrErrorCode,
	message: string,
	details?: unknown,
): Err {
	return { ok: false, error: { code, message, details } };
}

const sleep = (ms: number): Promise<void> =>
	new Promise((r) => setTimeout(r, ms));

/**
 * Parse PI_HERDR_SPAWN_DEPTH. Unset/empty/malformed/non-positive → 1 (a
 * root session that was never spawned). Single-int contract (ticket 07's
 * env-contract discipline: PI_HERDR_* vars are single-value scalars).
 */
export function parseSpawnDepth(raw: string | undefined): number {
	if (raw === undefined || raw.trim() === "") return 1;
	const n = Number.parseInt(raw, 10);
	return Number.isInteger(n) && n >= 1 ? n : 1;
}

/** The three gates, checked in order (kill-switch → depth → cap). */
export type GateOutcome =
	| { decision: "spawn" }
	| { decision: "queue" }
	| {
			decision: "refuse";
			error: { code: HerdrErrorCode; message: string; details?: unknown };
	  };

export function checkGates(
	settings: HerdrSettings,
	env: { PI_HERDR_SPAWN_DEPTH?: string },
	liveCount: number,
): GateOutcome {
	// 1. kill-switch: a gate only — refuses new spawns, never terminates.
	if (settings.agents_kill_switch) {
		return {
			decision: "refuse",
			error: spawnErr(
				"SPAWN_REFUSED",
				"spawn refused: agents_kill_switch is set (toggle it in the /herdr menu). This gate never terminates running agents.",
			).error,
		};
	}
	// 2. spawn depth: this session's depth comes from the env counter (unset =
	//    1); the child would be one deeper; refuse over max_spawn_depth.
	const depth = parseSpawnDepth(env.PI_HERDR_SPAWN_DEPTH);
	const childDepth = depth + 1;
	if (childDepth > settings.max_spawn_depth) {
		return {
			decision: "refuse",
			error: spawnErr(
				"SPAWN_REFUSED",
				`spawn refused: this session is at spawn depth ${depth} (PI_HERDR_SPAWN_DEPTH) and a child would be depth ${childDepth} > max_spawn_depth ${settings.max_spawn_depth}. Raise max_spawn_depth in the /herdr menu if deeper nesting is intended.`,
			).error,
		};
	}
	// 3. parallel cap: at capacity the spawn is ACCEPTED as queued (ticket 03
	//    decision 4) — no pane until a slot frees.
	if (liveCount >= settings.max_parallel_agents) {
		return { decision: "queue" };
	}
	return { decision: "spawn" };
}

/** Uniquify a pane-handle base against taken names (`-2`, `-3`, …). */
export function uniqueHandle(base: string, taken: ReadonlySet<string>): string {
	let handle = base;
	let i = 2;
	while (taken.has(handle)) handle = `${base}-${i++}`;
	return handle;
}

// ---- multiline arg materialization --------------------------------------------
// herdr's `agent start --` surface encodes extra agent args into a
// shell-safe command line for the target pane and REFUSES values it cannot
// encode (newlines → "agent arguments cannot be encoded safely for the target
// shell"). pi's --system-prompt / --append-system-prompt natively read an
// existing file PATH (resource loader resolves the value through existsSync),
// so multiline pi prompts are materialized to temp files and passed by path.
// claude cannot read prompt files by flag (capability matrix) and no other
// multiline value has a carrier — both refuse honestly (enforce-or-error).

export interface MaterializeDeps {
	writeFile?: (path: string, text: string) => void;
	tmpPath?: (handle: string, n: number) => string;
}

const PROMPT_FILE_FLAGS = new Set([
	"--system-prompt",
	"--append-system-prompt",
]);

function slug(handle: string): string {
	return handle.replace(/[^a-zA-Z0-9-]+/g, "-").slice(0, 40) || "agent";
}

/**
 * Rewrite multiline system-prompt values into temp-file paths (pi only).
 * Any other multiline value — or a multiline prompt under a non-pi kind —
 * errors naming the constraint. Pure aside from the injected writeFile.
 */
export function materializeAgentArgs(
	args: string[],
	handle: string,
	kind: string,
	deps: MaterializeDeps = {},
): Result<string[]> {
	const writeFile =
		deps.writeFile ??
		((path: string, text: string) => {
			// tmpdir() always exists — no mkdir needed; failures surface below
			writeFileSync(path, text, "utf8");
		});
	const tmpPath =
		deps.tmpPath ??
		((h: string, n: number) =>
			join(tmpdir(), `pi-herdr-spawn-${slug(h)}-sysprompt-${n}.md`));
	const isPi = kind.toLowerCase() === "pi";
	const out: string[] = [];
	let fileN = 0;
	for (let i = 0; i < args.length; i++) {
		const flag = args[i];
		const value = args[i + 1];
		const isPair =
			typeof value === "string" && i + 1 < args.length && flag.startsWith("--");
		if (isPair && /[\r\n]/.test(value)) {
			if (isPi && PROMPT_FILE_FLAGS.has(flag)) {
				fileN++;
				const path = tmpPath(handle, fileN);
				try {
					writeFile(path, value);
				} catch (e) {
					return spawnErr(
						"AGENT_START_FAILED",
						`could not write system prompt file ${path}: ${e instanceof Error ? e.message : String(e)}`,
					);
				}
				out.push(flag, path);
				i++;
				continue;
			}
			const carrier = isPi
				? `only ${[...PROMPT_FILE_FLAGS].join(" / ")} values can carry newlines (via temp file)`
				: `kind "${kind}" has no file-based system-prompt flag`;
			return spawnErr(
				"VALIDATION_ERROR",
				`herdr cannot pass multiline values through agent args (${flag}), and ${carrier}. Use a single-line value, agent_args with a file path, or another kind.`,
				{ flag },
			);
		}
		out.push(flag);
	}
	return { ok: true, data: out };
}

// ---- per-kind enforcement (capability matrix) ---------------------------------

export interface KindCaps {
	model: boolean;
	systemPrompt: boolean;
	tools: boolean;
	excludeTools: boolean;
	skills: boolean;
}

/**
 * What each known kind can honestly enforce at launch (verified flags in
 * wayfinder/research/capability-matrix.md: pi 0.85.1, claude 2.1.263,
 * codex 0.135.0 + survey). Unknown kinds enforce nothing structured — they
 * get `agent_args` only, per ticket 11's passthrough ruling.
 */
export const KIND_CAPABILITIES: Readonly<Record<string, KindCaps>> = {
	pi: {
		model: true,
		systemPrompt: true,
		tools: true,
		excludeTools: true,
		skills: true,
	},
	claude: {
		model: true,
		systemPrompt: true,
		tools: true,
		excludeTools: true,
		skills: false,
	},
	codex: {
		model: true,
		systemPrompt: false,
		tools: false,
		excludeTools: false,
		skills: false,
	},
	gemini: {
		model: true,
		systemPrompt: false,
		tools: false,
		excludeTools: false,
		skills: false,
	},
	cursor: {
		model: true,
		systemPrompt: false,
		tools: false,
		excludeTools: false,
		skills: false,
	},
	opencode: {
		model: true,
		systemPrompt: false,
		tools: false,
		excludeTools: false,
		skills: false,
	},
};

const NO_CAPS: KindCaps = {
	model: false,
	systemPrompt: false,
	tools: false,
	excludeTools: false,
	skills: false,
};

export function kindCaps(kind: string): KindCaps {
	return KIND_CAPABILITIES[kind.toLowerCase()] ?? NO_CAPS;
}

/** Kinds that can enforce `field` (for the enforce-or-error message). */
function kindsSupporting(field: keyof KindCaps): string[] {
	return Object.entries(KIND_CAPABILITIES)
		.filter(([, caps]) => caps[field])
		.map(([k]) => k);
}

/** A merged spawn spec: the definition with kind/model resolved onto it. */
export interface SpawnSpec extends AgentDefinition {
	/** Resolved kind: spawn param > definition > settings default_kind. */
	kind: string;
}

/** Merge spawn-level kind/model over the definition; defaults fill the rest. */
export function mergeSpawnSpec(
	def: AgentDefinition,
	over: { kind?: string; model?: string },
	defaultKind: string,
): SpawnSpec {
	return {
		...def,
		kind: over.kind ?? def.kind ?? defaultKind,
		model: over.model ?? def.model,
	};
}

/**
 * Enforce-or-error: every set field the (merged) kind cannot enforce errors,
 * naming the field and pointing at agent_args or a kind that supports it.
 * Wayfinder ticket 01 decision 2 — never silently drop a set field.
 */
export function validateKindEnforcement(spec: SpawnSpec): Err | null {
	const caps = kindCaps(spec.kind);
	const checks: [keyof KindCaps, string, boolean][] = [
		["systemPrompt", "system_prompt", Boolean(spec.system_prompt)],
		["tools", "tools", Boolean(spec.tools?.length)],
		["excludeTools", "exclude_tools", Boolean(spec.exclude_tools?.length)],
		["skills", "skills", Boolean(spec.skills?.length)],
		["model", "model", Boolean(spec.model)],
	];
	for (const [cap, field, isSet] of checks) {
		if (isSet && !caps[cap]) {
			return spawnErr(
				"VALIDATION_ERROR",
				`kind "${spec.kind}" cannot enforce "${field}" — pass raw flags via agent_args, or use a kind with native support (${kindsSupporting(cap).join(", ")}).`,
				{ field, kind: spec.kind },
			);
		}
	}
	return null;
}

/**
 * Compile the merged spec into agent-CLI flags (appended after herdr's
 * `agent start --kind` / the preset argv). Only fields the capability table
 * marked enforceable reach here (validateKindEnforcement ran first), so the
 * switch below mirrors the table exactly.
 */
export function buildAgentArgs(spec: SpawnSpec): string[] {
	const args: string[] = [];
	const kind = spec.kind.toLowerCase();
	switch (kind) {
		case "pi":
			if (spec.system_prompt) {
				args.push(
					spec.prompt_mode === "append"
						? "--append-system-prompt"
						: "--system-prompt",
					spec.system_prompt,
				);
			}
			if (spec.model) args.push("--model", spec.model);
			if (spec.tools?.length) args.push("--tools", spec.tools.join(","));
			if (spec.exclude_tools?.length)
				args.push("--exclude-tools", spec.exclude_tools.join(","));
			for (const s of spec.skills ?? []) args.push("--skill", s);
			break;
		case "claude":
			if (spec.system_prompt) {
				args.push(
					spec.prompt_mode === "append"
						? "--append-system-prompt"
						: "--system-prompt",
					spec.system_prompt,
				);
			}
			if (spec.model) args.push("--model", spec.model);
			if (spec.tools?.length) args.push("--tools", spec.tools.join(","));
			if (spec.exclude_tools?.length)
				args.push("--disallowedTools", spec.exclude_tools.join(","));
			break;
		case "codex":
		case "gemini":
		case "cursor":
		case "opencode":
			// model-only kinds (verified --model/-m flags in the matrix survey)
			if (spec.model) args.push("--model", spec.model);
			break;
		default:
			// unknown kinds: agent_args only (ticket 11 passthrough)
			break;
	}
	if (spec.agent_args?.length) args.push(...spec.agent_args);
	return args;
}

// ---- session spawn registry ----------------------------------------------------
// name (pane handle) → live record. Consulted by the queue drain here, and by
// later v0.5 tickets (notifications watcher, get_agent_result six-state).

export interface SpawnRecord {
	/** Pane handle (unique-ified at accept). */
	name: string;
	kind: string;
	/** Definition registry name (`type`, or an inline definition's name). */
	type?: string;
	prompt: string;
	agentArgs: string[];
	/** Child depth stamped into PI_HERDR_SPAWN_DEPTH. */
	depth: number;
	isolated: boolean;
	cwd?: string;
	/** PI_HERDR_ORCHESTRATOR_PANE stamped when the spawner runs in a pane. */
	orchestratorPane?: string;
	paneId?: string;
	spawnedAt: number;
	startedAt?: number;
	/** Prompt was submitted (any settled idle afterwards = done). */
	submitted: boolean;
	sawWorking: boolean;
	/** Last live agent_status observed (diagnostics). */
	lastStatus?: string;
	/** Set when a deferred (queued) start failed — status reads "gone". */
	startError?: string;
	worktreePath?: string;
}

const spawnRegistry = new Map<string, SpawnRecord>();

/** Live registry snapshot (later tickets consume this). */
export function spawnRecords(): ReadonlyMap<string, SpawnRecord> {
	return spawnRegistry;
}

/** Drop every registry entry (tests). */
export function clearSpawnRegistry(): void {
	spawnRegistry.clear();
}

/** Records accepted but not yet started (the queue, in accept order). */
function queuedRecords(): SpawnRecord[] {
	return [...spawnRegistry.values()].filter((r) => !r.paneId && !r.startError);
}

// ---- injectable seams ------------------------------------------------------------

export interface SpawnDeps {
	/** Effective settings — default: live read of both settings files. */
	load?: () => HerdrSettings;
	/** Live agent kinds — default: cached `herdr agent` kind list. */
	kinds?: () => Promise<string[]>;
	/** Live agents (fleet) — default: `herdr agent list`. */
	list?: () => Promise<{ name?: string; paneId?: string }[]>;
	/** Pane creation — default: startHerdrAgent (version-branched). */
	start?: typeof startHerdrAgent;
	/** Boot gate — default: waitForStatus(["idle"]) (event + poll). */
	boot?: (
		paneId: string,
		budgetMs: number,
		signal?: AbortSignal,
	) => Promise<Result<true>>;
	/** Submit + settle one turn — default: submitAndWait. */
	submit?: (
		paneId: string,
		text: string,
		deadline: number,
		signal?: AbortSignal,
	) => Promise<Result<true>>;
	/** Live agent_status — default: getAgentStatus. */
	status?: (paneId: string) => Promise<Result<string>>;
	/** Worktree creation — default: `herdr worktree create` (auto branch/path). */
	worktree?: (projectCwd: string) => Promise<Result<string>>;
	/** Env view — default: process.env. */
	env?: Record<string, string | undefined>;
	/** Disable the background queue-drain timer (tests drive drains explicitly). */
	autodrain?: boolean;
	signal?: AbortSignal;
}

const defaultLoad = (): HerdrSettings =>
	loadSettings(getSettingsPaths(process.cwd())).effective;

const defaultList = async (): Promise<{ name?: string; paneId?: string }[]> => {
	const r = await herdr<{ agents?: unknown[] }>(["agent", "list"], {
		timeoutMs: 10_000,
	});
	if (!r.ok) return [];
	return (r.data?.agents ?? []).map(normalizeAgent);
};

const defaultBoot = (
	paneId: string,
	budgetMs: number,
	signal?: AbortSignal,
): Promise<Result<true>> =>
	waitForStatus(paneId, ["idle"], Date.now() + budgetMs, signal);

const defaultSubmit = async (
	paneId: string,
	text: string,
	deadline: number,
	signal?: AbortSignal,
): Promise<Result<true>> => submitAndWait(paneId, text, { deadline, signal });

const defaultWorktree = async (projectCwd: string): Promise<Result<string>> => {
	const r = await herdr<unknown>(
		createWorktreeArgs({ cwd: projectCwd /* auto branch+path */ }),
		{ timeoutMs: 30_000 },
	);
	if (!r.ok) return r;
	const path = extractWorktree(r.data).path;
	if (!path) {
		return spawnErr("PANE_GONE", "worktree create returned no path", r.data);
	}
	return { ok: true, data: path };
};

// ---- status derivation ------------------------------------------------------------

/** Map a live agent_status (+ record state) onto the six-state vocabulary. */
export function deriveStatus(
	record: SpawnRecord,
	live: string | undefined,
): SpawnStatus {
	if (!record.paneId) return record.startError ? "gone" : "queued";
	switch (live) {
		case "blocked":
			return "blocked";
		case "working":
			record.sawWorking = true;
			return "working";
		case "unknown":
			return "working"; // boot/spawn window — honest enough, still live
		case "idle":
		case "done":
			// The spawn submitted the prompt, so a settled idle holds an
			// unconsumed result → done (ticket 10's derivation). Pre-submit
			// idle (booted, prompt not yet in) stays idle.
			return record.submitted || record.sawWorking ? "done" : "idle";
		default:
			return "working";
	}
}

async function currentStatus(
	record: SpawnRecord,
	deps: SpawnDeps,
): Promise<SpawnStatus> {
	if (!record.paneId) return record.startError ? "gone" : "queued";
	const statusOf = deps.status ?? getAgentStatus;
	const r = await statusOf(record.paneId);
	if (!r.ok) {
		// pane/agent gone (agent_not_found / NOT_FOUND) vs a transient error
		const code = r.error.code;
		const inner = (r.error.details as { code?: string } | undefined)?.code;
		if (code === "NOT_FOUND" || inner === "agent_not_found") return "gone";
		return "working"; // transient — keep the last-known-live view
	}
	record.lastStatus = r.data;
	return deriveStatus(record, r.data);
}

// ---- the start path (shared by direct spawns and queue drain) -----------------------

const BOOT_BUDGET_MS = 90_000; // a spawned pi can sit in `unknown` ~40-60s
const SETTLE_MS = 1_500; // TUI input readiness (PRD §2.2)
const SUBMIT_CHUNK_MS = 120_000; // per-attempt turn budget for wait:true

/**
 * Start the pane for an accepted record: (worktree →) pane → boot gate →
 * prompt submission. Sets paneId/submitted/worktreePath on the record.
 */
export async function startRecordNow(
	record: SpawnRecord,
	deps: SpawnDeps = {},
): Promise<Result<{ paneId: string }>> {
	const signal = deps.signal;

	// 1. isolated → herdr-side worktree (auto branch+path via the existing
	//    worktree machinery). The pane itself stays in the current workspace.
	let cwd = record.cwd;
	if (record.isolated) {
		const wt = await (deps.worktree ?? defaultWorktree)(
			record.cwd ?? process.cwd(),
		);
		if (!wt.ok) return wt;
		record.worktreePath = wt.data;
		cwd = wt.data;
	}

	// 2. pane (herdr's native kind axis; version-branched launcher)
	const childEnv: Record<string, string> = {
		PI_HERDR_SPAWN_DEPTH: String(record.depth),
	};
	if (record.orchestratorPane) {
		childEnv.PI_HERDR_ORCHESTRATOR_PANE = record.orchestratorPane;
	}
	const start = deps.start ?? startHerdrAgent;
	const startR = await start({
		name: record.name,
		agent: record.kind,
		agentArgs: record.agentArgs,
		cwd,
		env: childEnv,
		signal,
	});
	if (!startR.ok) return startR;
	record.paneId = normalizeAgent(startR.data.agent).paneId;
	record.startedAt = Date.now();
	if (!record.paneId) {
		return spawnErr(
			"AGENT_START_FAILED",
			"agent start returned no pane id",
			startR.data,
		);
	}

	// 3. boot gate: wait for the first idle before typing the prompt.
	const boot = await (deps.boot ?? defaultBoot)(
		record.paneId,
		BOOT_BUDGET_MS,
		signal,
	);
	if (!boot.ok) {
		return spawnErr(
			"AGENT_START_FAILED",
			`agent in pane ${record.paneId} never became idle (boot) within ${BOOT_BUDGET_MS}ms: ${boot.error.message}`,
			{ paneId: record.paneId, name: record.name },
		);
	}
	await sleep(SETTLE_MS);

	// 4. submit the prompt; retry once when the turn never started (the
	//    prompt can be lost if typed before the TUI input was ready).
	await submitRecordPrompt(record, deps);
	const status = await currentStatus(record, deps);
	if (status === "idle") {
		// submission failed outright — surface it with the pane id so the
		// caller can steer/close by handle
		return spawnErr(
			"AGENT_NOT_READY",
			`prompt could not be submitted to pane ${record.paneId} (${record.name}); the pane exists — retry via the agent surface`,
			{ paneId: record.paneId, name: record.name },
		);
	}
	return { ok: true, data: { paneId: record.paneId } };
}

async function submitRecordPrompt(
	record: SpawnRecord,
	deps: SpawnDeps,
): Promise<void> {
	if (!record.paneId) return;
	const submit = deps.submit ?? defaultSubmit;
	const deadline = Date.now() + SUBMIT_CHUNK_MS;
	for (let attempt = 0; attempt < 2; attempt++) {
		if (attempt > 0) await sleep(2_000);
		const r = await submit(record.paneId, record.prompt, deadline, deps.signal);
		if (r.ok || r.error.message !== "NOT_STARTED") break; // only retry lost turns
	}
	record.submitted = true;
}

// ---- queue drain ---------------------------------------------------------------------

const DRAIN_INTERVAL_MS = 3_000;
let drainTimer: NodeJS.Timeout | null = null;

/** Best-effort background drain while anything is queued (self-scheduling). */
function ensureDrainLoop(deps: SpawnDeps): void {
	if (drainTimer || deps.autodrain === false) return;
	const tick = async (): Promise<void> => {
		drainTimer = null;
		try {
			await drainQueueOnce(deps);
		} catch {
			/* best-effort */
		}
		if (queuedRecords().length) {
			drainTimer = setTimeout(tick, DRAIN_INTERVAL_MS);
			drainTimer.unref?.();
		}
	};
	drainTimer = setTimeout(tick, DRAIN_INTERVAL_MS);
	drainTimer.unref?.();
}

/**
 * One drain pass: count live session-spawned agents (registry panes still in
 * the fleet), start as many queued records as slots allow. The cap counts
 * THIS SESSION's spawned agents (the watch-scope decision from ticket 04:
 * hand-spawned panes stay the human's business).
 */
export async function drainQueueOnce(deps: SpawnDeps = {}): Promise<number> {
	const queued = queuedRecords();
	if (!queued.length) return 0;
	const live = await (deps.list ?? defaultList)();
	const livePaneIds = new Set(
		live.map((a) => a.paneId).filter((p): p is string => Boolean(p)),
	);
	const running = [...spawnRegistry.values()].filter(
		(r) => r.paneId && livePaneIds.has(r.paneId),
	).length;
	const cap = (deps.load ?? defaultLoad)().max_parallel_agents;
	let free = Math.max(0, cap - running);
	let started = 0;
	for (const record of queued) {
		if (free <= 0) break;
		free--;
		const r = await startRecordNow(record, deps);
		if (!r.ok) {
			record.startError = r.error.message;
			continue; // slot stays used-for-now; a later pass may retry nothing (record marked)
		}
		started++;
	}
	return started;
}

// ---- wait phase ------------------------------------------------------------------------

/**
 * Block until the record reaches a terminal state (done | blocked | gone) or
 * the budget expires. `true` = unbounded (only the parent signal aborts);
 * a number returns the CURRENT state on expiry. Waits through the queue.
 */
export async function waitPhase(
	record: SpawnRecord,
	wait: true | number,
	deps: SpawnDeps = {},
): Promise<SpawnStatus> {
	const deadline = wait === true ? Infinity : Date.now() + wait;
	for (;;) {
		if (deps.signal?.aborted) return currentStatus(record, deps);
		const st = await currentStatus(record, deps);
		if (st === "done" || st === "blocked" || st === "gone") return st;
		if (Date.now() >= deadline) return st;
		await sleep(1_500);
	}
}

// ---- the spawn entry point ---------------------------------------------------------------

export interface SpawnParams {
	prompt: string;
	type?: string;
	agent?: unknown;
	name?: string;
	kind?: string;
	model?: string;
	cwd?: string;
	isolated?: boolean;
	wait?: boolean | number;
}

export interface SpawnResultData {
	name: string;
	status: SpawnStatus;
	paneId?: string;
	kind: string;
	type?: string;
	/** Child depth stamped into PI_HERDR_SPAWN_DEPTH. */
	depth: number;
	queued?: boolean;
	worktreePath?: string;
	waited?: boolean;
}

export type SpawnResult = Result<SpawnResultData>;

/**
 * spawn_agent, end to end. Pure validations first (specifier, merge,
 * enforce-or-error), then the three gates in order, then — and only then —
 * side effects: handle registration, worktree, pane, prompt.
 */
export async function spawnAgent(
	params: SpawnParams,
	deps: SpawnDeps = {},
): Promise<SpawnResult> {
	const signal = deps.signal;

	// 1. specifier: `type` xor `agent` (pure)
	const spec = resolveSpecifier({ type: params.type, agent: params.agent });
	if (!spec.ok) return spec;
	const { definition, inline } = spec.data;

	// 2. settings (read-at-use: gates consult the moment they matter)
	const settings = (deps.load ?? defaultLoad)();

	// 3. merge + enforce-or-error (pure)
	if (params.isolated && params.cwd) {
		return spawnErr(
			"VALIDATION_ERROR",
			"`isolated` and `cwd` are mutually exclusive: isolated spawns into a fresh auto-created herdr worktree. For full control compose herdr_worktree_create + cwd.",
		);
	}
	const merged = mergeSpawnSpec(
		definition,
		{ kind: params.kind, model: params.model },
		settings.default_kind,
	);
	const enforcement = validateKindEnforcement(merged);
	if (enforcement) return enforcement;
	const agentArgs = buildAgentArgs(merged);

	// 4. fleet snapshot (read-only) — feeds the cap count + handle uniquify
	const live = await (deps.list ?? defaultList)();
	const liveCount = live.filter((a) => a.paneId).length;

	// 5. gates, in order, before any side effect
	const env = deps.env ?? process.env;
	const gates = checkGates(settings, env, liveCount);
	if (gates.decision === "refuse") return { ok: false, error: gates.error };

	// 6. kind must exist in herdr's native kind list (clear error up front)
	const kinds = await (deps.kinds ?? getAgentKinds)();
	const badKind = kindError(merged.kind, kinds);
	if (badKind) return { ok: false, error: badKind.error };

	// 7. side effects start here: handle, session registration, record
	const taken = new Set([
		...live.map((a) => a.name).filter((n): n is string => Boolean(n)),
		...spawnRegistry.keys(),
	]);
	const base =
		params.name ?? (definition.name ? definition.name : `agent-${Date.now()}`);
	const handle = uniqueHandle(base, taken);
	if (inline && definition.name) {
		// session-ephemeral registration: later spawns may `type:` this name
		registerSessionAgent(definition);
	}

	// multiline values must be carried by temp files (pi prompt flags) or the
	// spawn refuses — herdr's arg encoder rejects newlines outright
	const mat = materializeAgentArgs(agentArgs, handle, merged.kind);
	if (!mat.ok) return mat;

	const env2 = deps.env ?? process.env;
	const record: SpawnRecord = {
		name: handle,
		kind: merged.kind,
		type: definition.name || params.type,
		prompt: params.prompt,
		agentArgs: mat.data,
		depth: parseSpawnDepth(env2.PI_HERDR_SPAWN_DEPTH) + 1,
		isolated: Boolean(params.isolated),
		cwd: params.cwd,
		orchestratorPane: env2.HERDR_PANE_ID,
		spawnedAt: Date.now(),
		submitted: false,
		sawWorking: false,
	};
	spawnRegistry.set(handle, record);

	// 8a. over cap → queued, no pane; the drain loop starts it when a slot
	// frees. A wait still applies: it polls through the queue until terminal
	// (ticket 03 decision 4 — wait waits through the queue).
	if (gates.decision === "queue") {
		ensureDrainLoop(deps);
		if (params.wait === undefined || params.wait === false) {
			return {
				ok: true,
				data: {
					name: handle,
					status: "queued",
					kind: merged.kind,
					type: record.type,
					depth: record.depth,
					queued: true,
				},
			};
		}
		const status = await waitPhase(record, params.wait, { ...deps, signal });
		return {
			ok: true,
			data: {
				name: handle,
				status,
				paneId: record.paneId,
				kind: merged.kind,
				type: record.type,
				depth: record.depth,
				queued: true,
				worktreePath: record.worktreePath,
				waited: true,
			},
		};
	}

	// 8b. start now
	const startR = await startRecordNow(record, deps);
	if (!startR.ok) {
		return {
			ok: false,
			error: {
				...startR.error,
				details: {
					...(typeof startR.error.details === "object" && startR.error.details
						? startR.error.details
						: {}),
					name: handle,
					paneId: record.paneId,
				},
			},
		};
	}

	// 9. wait vocabulary: default = return immediately; true = done-or-blocked;
	//    ms = current state on expiry. Queued records wait through the queue.
	if (params.wait === undefined || params.wait === false) {
		return {
			ok: true,
			data: {
				name: handle,
				status: await currentStatus(record, deps),
				paneId: record.paneId,
				kind: merged.kind,
				type: record.type,
				depth: record.depth,
				worktreePath: record.worktreePath,
			},
		};
	}
	const status = await waitPhase(record, params.wait, { ...deps, signal });
	return {
		ok: true,
		data: {
			name: handle,
			status,
			paneId: record.paneId,
			kind: merged.kind,
			type: record.type,
			depth: record.depth,
			worktreePath: record.worktreePath,
			waited: true,
		},
	};
}
