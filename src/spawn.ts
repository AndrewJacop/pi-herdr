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
//   - no layout params (charter item 2): panes split right in the current tab;
//     layout/tab/worktree tools are off the model surface entirely (v0.6
//     surface cut) — the worktree MACHINERY stays for `isolated`.
//
// Ticket 11's pi-only scope ruling: `kind` is an unopinionated passthrough
// onto herdr's native `agent start --kind` axis. A non-pi child is text in a
// pane with a TUI-detected lifecycle, nothing else — hence the strict
// capability table below (verified in wayfinder/research/capability-matrix.md).

import { getAgentKinds } from "./config.js";
import { herdr } from "./herdr.js";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { seedSessionFile, writeSteerWatermark } from "./sessionfile.js";
import {
	type Err,
	type HerdrErrorCode,
	type NormalizedAgent,
	normalizeAgent,
	type Result,
} from "./env.js";
import {
	getSettingsPaths,
	loadSettings,
	type HerdrSettings,
} from "./settings.js";
import {
	type AgentDirs,
	defaultAgentDirs,
	registerSessionAgent,
	resolveSpecifier,
	type AgentDefinition,
	type SessionMode,
} from "./agentdefs.js";
import {
	buildIdentityBlock,
	buildLaunchPlan,
	buildModeHintBlock,
	buildTaskPrompt,
	composePromptFlags,
	type ParentRouting,
	resolveRouting,
	type RoutingRegistry,
	type RoutingResolution,
	validateRouting,
} from "./launchplan.js";
import {
	buildSessionSeedLines,
	parseSessionEntries,
} from "./sessionfile.js";

// The agent-definition API future tickets and tests consume THROUGH this
// module: jiti-based tests importing src/agentdefs.ts directly would get a
// separate module instance (mutable session state must have ONE home), and
// get_agent_result / message_agent will layer on spawn-engine state anyway.
export {
	BUILT_IN_AGENTS,
	clearSessionAgents,
	listAgentTypes,
	loadFileAgents,
	parseAgentMarkdown,
	formatAgentMarkdown,
	defaultAgentDirs,
	saveAgent,
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

// ---- stance (v0.6 issue 03 fields, issue 04 semantics) -----------------------

/** Whether a child pane closes itself when its work settles. */
export type Stance = "autonomous" | "interactive";

/**
 * Derive the stance from the definition's `auto_exit` / `interactive` fields:
 * autonomous is the default (auto-exit on settle); `interactive: true` is the
 * explicit override; `auto_exit: false` downgrades to interactive.
 */
export function deriveStance(def: {
	auto_exit?: boolean;
	interactive?: boolean;
}): Stance {
	if (def.interactive === true) return "interactive";
	if (def.auto_exit === false) return "interactive";
	return "autonomous";
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
	// ponytail: prompt files are never deleted — the child reads them during
	// boot (deleting after the boot gate would race slow boots). Deterministic
	// per-handle names keep re-spawns overwriting; OS tmp cleanup owns the rest.
	// Add per-spawn unlink after the boot gate if tmpdir growth ever matters.
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
	/** pi-only: `--thinking` exists; explicit thinking pins elsewhere refuse. */
	thinking: boolean;
	/** pi-only: the session-file substrate exists — lineage-only/fork (issue
	 * 09) are enforceable; other kinds have no session file to seed. */
	session: boolean;
}

/**
 * What each known kind can honestly enforce at launch (verified flags in
 * wayfinder/research/capability-matrix.md: pi 0.85.1, claude 2.1.263,
 * codex 0.135.0 + survey). `session` = has the pi session-file substrate
 * (issue 09's lineage-only/fork seeding rides it) — pi only. Unknown kinds
 * enforce nothing structured — they get `agent_args` only, per ticket 11's
 * passthrough ruling.
 */
export const KIND_CAPABILITIES: Readonly<Record<string, KindCaps>> = {
	pi: {
		model: true,
		systemPrompt: true,
		tools: true,
		excludeTools: true,
		skills: true,
		thinking: true,
		session: true,
	},
	claude: {
		model: true,
		systemPrompt: true,
		tools: true,
		excludeTools: true,
		skills: false,
		thinking: false,
		session: false,
	},
	codex: {
		model: true,
		systemPrompt: false,
		tools: false,
		excludeTools: false,
		skills: false,
		thinking: false,
		session: false,
	},
	gemini: {
		model: true,
		systemPrompt: false,
		tools: false,
		excludeTools: false,
		skills: false,
		thinking: false,
		session: false,
	},
	cursor: {
		model: true,
		systemPrompt: false,
		tools: false,
		excludeTools: false,
		skills: false,
		thinking: false,
		session: false,
	},
	opencode: {
		model: true,
		systemPrompt: false,
		tools: false,
		excludeTools: false,
		skills: false,
		thinking: false,
		session: false,
	},
};

const NO_CAPS: KindCaps = {
	model: false,
	systemPrompt: false,
	tools: false,
	excludeTools: false,
	skills: false,
	thinking: false,
	session: false,
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

/** A merged spawn spec: the definition with kind/model/thinking resolved onto it. */
export interface SpawnSpec extends AgentDefinition {
	/** Resolved kind: spawn param > definition > settings default_kind. */
	kind: string;
}

/**
 * Merge spawn-level kind/model/thinking over the definition; defaults fill
 * the rest. Routing levels 3–5 (settings pins, parent inheritance) are
 * resolved separately (resolveRouting) and assigned onto the merged spec by
 * the caller before validation/flag-building.
 */
export function mergeSpawnSpec(
	def: AgentDefinition,
	over: { kind?: string; model?: string; thinking?: string },
	defaultKind: string,
): SpawnSpec {
	return {
		...def,
		kind: over.kind ?? def.kind ?? defaultKind,
		model: over.model ?? def.model,
		thinking: over.thinking ?? def.thinking,
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
		// "standalone" is the no-op default; only a meaningful session mode
		// needs the pi session substrate (issue 09).
		[
			"session",
			"session_mode",
			Boolean(spec.session_mode && spec.session_mode !== "standalone"),
		],
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
 * marked enforceable reach here (validateKindEnforcement + validateRouting
 * ran first), so the switch below mirrors the table exactly. For pi children
 * `opts.child` also folds the identity + mode-hint blocks into the prompt
 * flags (issue 08); without it the definition's own prompt flags are emitted
 * unchanged. Raw agent_args append LAST — spawn-level ones were concatenated
 * after the definition's by mergeSpawnSpec's caller (last-wins override).
 * The launch-plan substrate for pi children (parent-owned `--session` +
 * injected `-e child.ts`) is composed by buildLaunchPlan at start time —
 * see startRecordNow.
 */
export function buildAgentArgs(
	spec: SpawnSpec,
	opts?: {
		child?: {
			name: string;
			type?: string;
			stance: Stance;
			sessionMode?: SessionMode;
		};
	},
): string[] {
	const args: string[] = [];
	const kind = spec.kind.toLowerCase();
	switch (kind) {
		case "pi": {
			const child = opts?.child;
			args.push(
				...composePromptFlags({
					defPrompt: spec.system_prompt,
					promptMode: spec.prompt_mode,
					identity: child
						? buildIdentityBlock({ name: child.name, type: child.type })
						: "",
					modeHint: child
						? buildModeHintBlock({
								stance: child.stance,
								sessionMode: child.sessionMode,
							})
						: "",
				}),
			);
			if (spec.model) args.push("--model", spec.model);
			if (spec.thinking) args.push("--thinking", spec.thinking);
			if (spec.tools?.length) args.push("--tools", spec.tools.join(","));
			if (spec.exclude_tools?.length)
				args.push("--exclude-tools", spec.exclude_tools.join(","));
			for (const s of spec.skills ?? []) args.push("--skill", s);
			break;
		}
		case "claude":
			args.push(
				...composePromptFlags({
					defPrompt: spec.system_prompt,
					promptMode: spec.prompt_mode,
				}),
			);
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
// the substrate consumers: get_agent_result (v0.6 issue 04), push delivery
// (06), the status projection (07), resume (10), the workflow host (08).
// v0.6 issue 04 grows it with the session substrate: sessionPath (the
// parent-owned pi session file), activityPath (sidecar path, reserved for 07),
// launchPlan (the exact composed agent argv handed to `agent start`), stance,
// and the denied-tools list the child strip reports.

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
	/** Parent-owned pi session file (pi children only; seeded before launch). */
	sessionPath?: string;
	/** Activity sidecar path — reserved for the status projection (07). */
	activityPath?: string;
	/** The exact composed agent argv handed to `agent start --` (post-injection). */
	launchPlan?: string[];
	/** Whether the pane closes itself on settle. */
	stance: Stance;
	/** How the child session begins (issue 09 consumes; rides the plan here). */
	session_mode?: SessionMode;
	/** Resolved model/thinking + the supplying routing level (issue 08). */
	routing?: RoutingResolution;
	/** Task artifact path when the prompt was written to `<session>.task.md`. */
	taskArtifactPath?: string;
	/** Denied tool names (pi children; stamped to the child for its strip). */
	deniedTools?: string[];
	/** Terminal event already steered to the orchestrator (issue 06) —
	 * one push per terminal event; 07 prunes fleet rows on this. */
	delivery?: { kind: DeliveryKind; at: number };
	/** A human took the pane over (child-reported <session>.takeover). */
	takenOver?: boolean;
	/** Turn cancelled (issue 10): when the parent sent Escape to the pane.
	 * Drives the projected `interrupted` state; cleared by new work (a
	 * message delivery) and reset by resume. */
	interruptedAt?: number;
	/** The merged spec at spawn time, captured BEFORE routing resolution
	 * (issue 10 resume fallback): the launch plan re-derivation falls back
	 * to this when the definition can't be re-resolved by `type` (anonymous
	 * inline spawn, deleted .md). Frontmatter pins are the spawn-time
	 * snapshot; routing levels 3–5 still resolve against CURRENT settings. */
	definition?: SpawnSpec;
	/** Workflow run id (v0.6 issue 12): the child belongs to a herdr_run_workflow
	 * run — the RUN reports for its children (one aggregated completion push),
	 * so per-child terminal pushes are suppressed and issue 14's card rehomes
	 * the rows. */
	workflow?: string;
	/** Message-less resume (issue 10): the boot IS the handoff — the
	 * original prompt must NOT be resubmitted. Rides the record so the
	 * queue drain's startRecordNow stays silent too. */
	resumeSilent?: boolean;
	/** The quiet `user took over <agent>` note was sent. */
	tookNotified?: boolean;
	/** A blocked wake was pushed for the current blocked episode. */
	blockedNotified?: boolean;
	/** First absence evidence — the bounded-grace measurement (ms epoch). */
	goneAt?: number;
	/** Watchdog bookkeeping (07): whether a stall ping was sent for the
	 * current episode, and when a broken-substrate problem was first seen.
	 * The stalled STATE itself is always derived (src/status.ts), never
	 * stored — this only dedupes pings and ages problems. */
	watch?: { stalled?: boolean; problemSince?: number };
}

const spawnRegistry = new Map<string, SpawnRecord>();

/** Terminal (or one-shot) events the delivery loop steers to the
 * orchestrator (issue 06). `blocked` is an episode wake, not terminal — the
 * record stays watchable; the rest mark `delivery` and end the watch. */
export type DeliveryKind = "done" | "error" | "gone" | "start-error" | "blocked";

/** Live registry snapshot (later tickets consume this). */
export function spawnRecords(): ReadonlyMap<string, SpawnRecord> {
	return spawnRegistry;
}

/** Drop every registry entry (tests). */
export function clearSpawnRegistry(): void {
	spawnRegistry.clear();
}

/** Insert a record directly (tests — resume/offline harnesses). */
export function putSpawnRecordForTests(record: SpawnRecord): void {
	spawnRegistry.set(record.name, record);
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
	/** Live agents, Result-wrapped — default: the shared fleetList(). Resume
	 * (issue 10) reads the fleet through THIS seam: a FAILED observation is
	 * never absence evidence, so the gone-check must see the failure. */
	fleet?: (signal?: AbortSignal) => Promise<Result<NormalizedAgent[]>>;
	/** Pane creation — default: startHerdrAgent (the single `agent start
	 * --kind` launch path). */
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
	/** `.md` registry folders — default: `<cwd>/.pi/agents` + global agents dir. */
	agentDirs?: AgentDirs;
	/** Session-file seeding — default: seedSessionFile (pi-default sessions dir). */
	seed?: (cwd: string) => { path: string; dir: string };
	/** The parent session file (issue 09) — lineage-only/fork read it for the
	 * header link + fork copy. Threaded from the tool's ctx.sessionManager.
	 * Absent/unreadable → a requested non-standalone mode degrades to
	 * standalone (recorded as such). */
	parentSession?: string;
	/** Parent-session reader — default: parse the file (injectable in tests). */
	readParentEntries?: (path: string) => Record<string, unknown>[] | null;
	/** Mode-content writer — default: newline-join the seed lines. */
	writeSessionSeed?: (path: string, lines: string[]) => void;
	/** Injected child-extension path — default: src/child.ts beside this module. */
	childExtension?: string;
	/** pi's model registry (exact lookup + auth checks) — threaded from the
	 * tool's ExtensionContext; required when a model must be validated. */
	registry?: RoutingRegistry;
	/** The parent session's active model (routing level 5). */
	parent?: ParentRouting;
	/** Disable the background queue-drain timer (tests drive drains explicitly). */
	autodrain?: boolean;
	signal?: AbortSignal;
}

const defaultLoad = (): HerdrSettings =>
	loadSettings(getSettingsPaths(process.cwd())).effective;
export { defaultLoad };

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

export async function currentStatus(
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
 * Absolute path of the injected child extension (src/child.ts, beside this
 * module) — resolvable from the child's pi process in dev trees and packaged
 * installs alike, since the file ships inside the package.
 */
export function childExtensionPath(): string {
	return fileURLToPath(new URL("./child.ts", import.meta.url));
}

/**
 * Seed the parent-owned session substrate for a pi child (v0.6 issue 04):
 * the session file in pi's DEFAULT sessions dir for the child's (final) cwd —
 * the worktree path for isolated spawns, so isolated sessions file under
 * their own cwd — plus the reserved activity-sidecar path beside it.
 * Idempotent per record — the queue drain may start a record after prior
 * attempts seeded it. Returns a clean error instead of throwing: a seeding
 * failure (permissions, collision) must surface as a normal spawn error.
 */
function seedRecordSession(
	record: SpawnRecord,
	cwd: string,
	deps: SpawnDeps,
): Err | null {
	if (record.kind.toLowerCase() !== "pi" || record.sessionPath) return null;
	let seeded: { path: string; dir: string };
	try {
		seeded = (deps.seed ?? seedSessionFile)(cwd);
		record.sessionPath = seeded.path;
		record.activityPath = `${seeded.path}.activity.json`;
	} catch (e) {
		return spawnErr(
			"AGENT_START_FAILED",
			`could not seed the child session file in pi's sessions dir: ${e instanceof Error ? e.message : String(e)}`,
		);
	}
	// Session mode (issue 09): standalone leaves the file EMPTY (pi writes its
	// own header on boot); lineage-only/fork write the child header with the
	// `parentSession` link (plus, for fork, the parent conversation truncated
	// just before its last user message). Without a readable parent session
	// there is nothing to seed — a lineage link or fork copy with no parent
	// conversation IS standalone on disk (empty file, pi-written header) — so
	// no content is written; `session_mode` keeps reporting the SELECTED mode
	// (what the launch plan rode), the file shows what actually happened.
	const mode = record.session_mode ?? "standalone";
	if (mode === "standalone") return null;
	const parentSession = deps.parentSession;
	const parentEntries = parentSession
		? ((deps.readParentEntries ?? readParentSessionFile)(parentSession) ?? null)
		: null;
	if (!parentSession || !parentEntries) return null;
	try {
		const lines = buildSessionSeedLines({
			cwd,
			parentSession,
			mode,
			parentEntries,
		});
		(deps.writeSessionSeed ?? writeSessionSeedFile)(seeded.path, lines);
	} catch (e) {
		return spawnErr(
			"AGENT_START_FAILED",
			`could not write the ${mode} seed content to ${seeded.path}: ${e instanceof Error ? e.message : String(e)}`,
		);
	}
	return null;
}

/** Read the parent's own session file into entries (null when unreadable). */
function readParentSessionFile(
	path: string,
): Record<string, unknown>[] | null {
	try {
		return parseSessionEntries(readFileSync(path, "utf8")).entries;
	} catch {
		return null;
	}
}

/** Write the mode's seed lines into the freshly created (empty) file. */
function writeSessionSeedFile(path: string, lines: string[]): void {
	writeFileSync(path, lines.join("\n") + "\n", "utf8");
}

/**
 * Start the pane for an accepted record: (worktree →) session seed → pane →
 * boot gate → prompt submission. Sets paneId/submitted/worktreePath and the
 * session substrate (sessionPath/activityPath/launchPlan) on the record.
 */
export async function startRecordNow(
	record: SpawnRecord,
	deps: SpawnDeps = {},
): Promise<Result<{ paneId: string }>> {
	const signal = deps.signal;

	// 1. isolated → herdr-side worktree (auto branch+path via the existing
	//    worktree machinery). The pane itself stays in the current workspace.
	//    A resume of an isolated record (issue 10) keeps ITS worktree — the
	//    session file was seeded under that cwd; creating another would
	//    orphan it.
	let cwd = record.worktreePath ?? record.cwd;
	if (record.isolated && !record.worktreePath) {
		const wt = await (deps.worktree ?? defaultWorktree)(
			record.cwd ?? process.cwd(),
		);
		if (!wt.ok) return wt;
		record.worktreePath = wt.data;
		cwd = wt.data;
	}

	// 2. session substrate (pi children): seed the parent-owned session file
	//    under pi's default sessions dir for the FINAL cwd (the worktree for
	//    isolated spawns); a long task is written to `<session>.task.md` and
	//    the submitted prompt becomes its one-line reference (issue 08). The
	//    full argv is composed by buildLaunchPlan — the substrate flags ahead
	//    of the spec's own. Non-pi kinds get the same builder's passthrough
	//    branch (plain argv, no substrate).
	if (isPiKind(record.kind)) {
		const seedErr = seedRecordSession(record, cwd ?? process.cwd(), deps);
		if (seedErr) return seedErr;
		// A message-less resume (issue 10) skips the task artifact: the
		// original prompt is already in the replayed session, not the task.
		if (!record.resumeSilent) {
			const task = buildTaskPrompt(record.prompt, record.sessionPath, {});
			if (!task.ok) return task;
			record.prompt = task.data.prompt;
			record.taskArtifactPath = task.data.artifactPath;
		}
	}
	record.launchPlan = buildLaunchPlan({
		kind: record.kind,
		sessionPath: record.sessionPath,
		childExtension: deps.childExtension ?? childExtensionPath(),
		specFlags: record.agentArgs,
	});

	// 3. pane (herdr's native kind axis; version-branched launcher)
	const childEnv: Record<string, string> = {
		PI_HERDR_SPAWN_DEPTH: String(record.depth),
	};
	if (record.orchestratorPane) {
		childEnv.PI_HERDR_ORCHESTRATOR_PANE = record.orchestratorPane;
	}
	if (record.sessionPath) {
		childEnv.PI_HERDR_SESSION = record.sessionPath;
		childEnv.PI_HERDR_NAME = record.name;
		childEnv.PI_HERDR_AGENT = record.type ?? "";
		childEnv.PI_HERDR_AUTO_EXIT = record.stance === "autonomous" ? "1" : "0";
		childEnv.PI_HERDR_DENIED_TOOLS = (record.deniedTools ?? []).join(",");
		if (record.activityPath)
			childEnv.PI_HERDR_ACTIVITY_FILE = record.activityPath;
		// idle re-arm window (issue 06): after a human takeover, settle + this
		// much quiet → the child auto-delivers (rearm-labeled) and closes.
		childEnv.PI_HERDR_IDLE_REARM_MS = String(
			Math.max(0, (deps.load ?? defaultLoad)().idle_rearm_minutes) * 60_000,
		);
	}
	const start = deps.start ?? startHerdrAgent;
	const startR = await start({
		name: record.name,
		agent: record.kind,
		agentArgs: record.launchPlan,
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
	//    A message-less resume (issue 10) submits NOTHING — the boot IS the
	//    handoff: pi replays the session and sits open. `submitted` is set
	//    so the projection reads the settled state as waiting (open and
	//    intentionally so), never a phantom forever-`starting`.
	if (record.resumeSilent) {
		record.submitted = true;
		return { ok: true, data: { paneId: record.paneId } };
	}
	await submitRecordPrompt(record, deps);
	const status = await currentStatus(record, deps);
	if (status === "idle") {
		// submission failed outright — surface it with the pane id so the
		// caller can steer/close by handle
		return spawnErr(
			"AGENT_START_FAILED",
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
		// Steer watermark (issue 06), stamped PER ATTEMPT: the exact text about
		// to be typed. The child matches its input event against it so the
		// parent's own steering is never mistaken for a human takeover — and a
		// re-submit after a lost turn re-stamps, so the retry is not misread.
		if (record.sessionPath) writeSteerWatermark(record.sessionPath, record.prompt);
		const r = await submit(record.paneId, record.prompt, deadline, deps.signal);
		if (r.ok || r.error.message !== "NOT_STARTED") break; // only retry lost turns
	}
	record.submitted = true;
}

// ---- queue drain ---------------------------------------------------------------------

const DRAIN_INTERVAL_MS = 3_000;
let drainTimer: NodeJS.Timeout | null = null;

/**
 * Best-effort background drain while anything is queued (self-scheduling).
 * Exported for resume (issue 10): an over-cap resume re-enters the same
 * queue the spawn path uses.
 */
export function ensureDrainLoop(deps: SpawnDeps): void {
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
	/** Task prompt (its first prompt). */
	prompt: string;
	/** Force session_mode "fork" (issue 09): the child boots with the parent
	 * conversation (truncated before the parent's last user message) as
	 * context — the /iterate-style composition. Overrides the definition's
	 * `session_mode`. */
	fork?: boolean;
	type?: string;
	agent?: unknown;
	name?: string;
	kind?: string;
	model?: string;
	/** Routing level 1: thinking pin (pi children emit `--thinking`). */
	thinking?: string;
	/** Raw CLI flags appended after the definition's (last-wins override). */
	agent_args?: string[];
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
	/** Parent-owned pi session file (pi children; seeded before launch — an
	 * isolated+queued spawn fills it when its worktree resolves at start). */
	sessionPath?: string;
	/** Activity sidecar path — reserved for the status projection (07). */
	activityPath?: string;
	/** Whether the pane closes itself on settle. */
	stance: Stance;
	/** How the child session begins (stands; consumed by 09's seeding). */
	session_mode?: SessionMode;
	/** Resolved model the child boots on (issue 08; routing's final value). */
	model?: string;
	/** Resolved thinking level (undefined = child's own default). */
	thinking?: string;
	/** Set when a queued record's deferred start failed (status reads "gone" —
	 * the closest terminal in the six-state vocabulary; no pane ever existed). */
	startError?: string;
}

export type SpawnResult = Result<SpawnResultData>;

/** The pi-kind test for the session substrate (record/start-side; the
 * capability table covers enforceable fields, launchplan covers its own). */
const isPiKind = (kind: string): boolean => kind.toLowerCase() === "pi";

/** The routing/session-mode fields every spawn return path carries (issue
 * 08) — extracted so the four return sites can't drift apart. */
function routingResultFields(
	routing: RoutingResolution,
	sessionMode: SessionMode | undefined,
): Partial<SpawnResultData> {
	return {
		...(routing.model ? { model: routing.model } : {}),
		...(routing.thinking ? { thinking: routing.thinking } : {}),
		...(sessionMode ? { session_mode: sessionMode } : {}),
	};
}

/** The routing + session-substrate fields every return path reports: routing
 * resolution, the (selected) session mode, and the seeded file paths when
 * they exist — one helper so the four return sites can't drift apart. */
function substrateResultFields(
	record: SpawnRecord,
	routing: RoutingResolution,
): Partial<SpawnResultData> {
	return {
		...routingResultFields(routing, record.session_mode),
		...(record.sessionPath ? { sessionPath: record.sessionPath } : {}),
		...(record.activityPath ? { activityPath: record.activityPath } : {}),
	};
}

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

	// 1. specifier: `type` xor `agent` (pure). File-backed types resolve from
	// the `.md` registry folders (project shadows global, read-at-use).
	const spec = resolveSpecifier(
		{ type: params.type, agent: params.agent },
		deps.agentDirs ?? defaultAgentDirs(),
	);
	if (!spec.ok) return spec;
	const { definition, inline } = spec.data;

	// 2. settings (read-at-use: gates consult the moment they matter)
	const settings = (deps.load ?? defaultLoad)();

	// 3. merge + enforce-or-error (pure)
	if (params.isolated && params.cwd) {
		return spawnErr(
			"VALIDATION_ERROR",
			"`isolated` and `cwd` are mutually exclusive: isolated spawns into a fresh auto-created herdr worktree.",
		);
	}
	const merged = mergeSpawnSpec(
		definition,
		{ kind: params.kind, model: params.model, thinking: params.thinking },
		settings.default_kind,
	);
	// Session-mode selection (issue 09): spawn-level `fork: true` forces fork
	// (the /iterate-style composition) over the definition's `session_mode`;
	// unset definition → standalone. Seeding itself happens at start time
	// (seedRecordSession), once the child's final cwd is known.
	if (params.fork) merged.session_mode = "fork";
	// Routing chain (issue 08): resolve model/thinking across all five levels
	// (spawn param > frontmatter > models.agents pin > models.default > parent
	// model; thinking never inherits from the parent), then enforce-or-error
	// BEFORE any side effect. Resolved values land on the merged spec so each
	// is emitted as exactly one --model/--thinking flag. Level-5 model on a
	// kind that cannot enforce a model flag is a NO-OP (nothing to enforce —
	// explicit levels 1–4 still refuse via validateKindEnforcement).
	const routing = resolveRouting({
		spawn: { model: params.model, thinking: params.thinking },
		definition,
		settings,
		parent: deps.parent,
	});
	// Resume fallback snapshot (issue 10): the spec BEFORE routing resolves
	// model/thinking onto it, so a fallback-path resume re-runs the chain
	// against CURRENT settings instead of replaying the dead run's pins.
	const definitionSnapshot: SpawnSpec = { ...merged };
	merged.model =
		routing.modelSource === "parent" && !kindCaps(merged.kind).model
			? undefined
			: routing.model;
	merged.thinking = routing.thinking;
	// Raw flags: frontmatter `args:` first, spawn-level agent_args appended —
	// later duplicates win by ordinary CLI semantics (the documented override).
	merged.agent_args = [
		...(merged.agent_args ?? []),
		...(params.agent_args ?? []),
	];
	const routingError = validateRouting(
		routing,
		kindCaps(merged.kind),
		deps.registry,
		definition.name || undefined,
		merged.kind,
	);
	if (routingError) return routingError;
	const enforcement = validateKindEnforcement(merged);
	if (enforcement) return enforcement;

	// 4. fleet snapshot (read-only) — feeds the cap count + handle uniquify
	const env = deps.env ?? process.env;
	const live = await (deps.list ?? defaultList)();
	// Cap semantics match the drain loop exactly: THIS SESSION's live spawned
	// agents (registry panes still in the fleet), not the whole fleet — the
	// watch-scope decision (ticket 04): hand-spawned panes stay the human's
	// business and never hold a session slot.
	const livePaneIds = new Set(
		live.map((a) => a.paneId).filter((p): p is string => Boolean(p)),
	);
	const liveCount = [...spawnRegistry.values()].filter(
		(r) => r.paneId && livePaneIds.has(r.paneId),
	).length;

	// 5. gates, in order, before any side effect
	const gates = checkGates(settings, env, liveCount);
	if (gates.decision === "refuse") return { ok: false, error: gates.error };

	// 6. kind must exist in herdr's native kind list (clear error up front)
	const kinds = await (deps.kinds ?? getAgentKinds)();
	const badKind = kindError(merged.kind, kinds);
	if (badKind) return { ok: false, error: badKind.error };

	// 7. side effects start here: handle, record, session registration
	const taken = new Set([
		...live.map((a) => a.name).filter((n): n is string => Boolean(n)),
		...spawnRegistry.keys(),
	]);
	const base =
		params.name ?? (definition.name ? definition.name : `agent-${Date.now()}`);
	const handle = uniqueHandle(base, taken);

	// multiline values must be carried by temp files (pi prompt flags) or the
	// spawn refuses — herdr's arg encoder rejects newlines outright. This is
	// the LAST validation: everything after it is a committed side effect.
	// The argv is built here (not earlier) so pi children fold in the identity
	// + mode-hint blocks under the FINAL handle (issue 08); raw agent_args
	// appended last by buildAgentArgs.
	const agentArgs = buildAgentArgs(
		merged,
		isPiKind(merged.kind)
			? {
					child: {
						name: handle,
						type: definition.name || undefined,
						stance: deriveStance(merged),
						sessionMode: merged.session_mode,
					},
				}
			: undefined,
	);
	const mat = materializeAgentArgs(agentArgs, handle, merged.kind);
	if (!mat.ok) return mat;

	// accepted spawn — an inline definition with a name registers
	// session-ephemerally here, AFTER every refusal path (agentdefs' contract:
	// accepted spawns only; a refused spec never pollutes the registry)
	if (inline && definition.name) {
		registerSessionAgent(definition);
	}

	const record: SpawnRecord = {
		name: handle,
		kind: merged.kind,
		type: definition.name || params.type,
		prompt: params.prompt,
		agentArgs: mat.data,
		depth: parseSpawnDepth(env.PI_HERDR_SPAWN_DEPTH) + 1,
		isolated: Boolean(params.isolated),
		// spawn cwd > definition cwd (frontmatter `cwd`); `isolated` ignores the
		// definition's — the worktree IS the cwd choice at spawn level
		cwd: params.cwd ?? (params.isolated ? undefined : merged.cwd),
		orchestratorPane: env.HERDR_PANE_ID,
		spawnedAt: Date.now(),
		submitted: false,
		sawWorking: false,
		stance: deriveStance(merged),
		session_mode: merged.session_mode,
		routing,
		deniedTools: merged.exclude_tools,
		definition: definitionSnapshot,
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
					stance: record.stance,
					...substrateResultFields(record, routing),
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
				stance: record.stance,
				worktreePath: record.worktreePath,
				waited: true,
				...substrateResultFields(record, routing),
				...(record.startError ? { startError: record.startError } : {}),
			},
		};
	}

	// 8b. start now
	const startR = await startRecordNow(record, deps);
	if (!startR.ok) {
		// Mark the record so get_agent_result answers "gone" (with the reason)
		// instead of a phantom forever-"queued" — wait: true must terminate.
		record.startError = startR.error.message;
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

	// 9. wait vocabulary. The DEFAULT (no wait) blocks through pane start +
	// boot gate + prompt submission, then returns — "returns immediately" in
	// wayfinder ticket 01 decision 6 contrasts with waiting for the TURN, not
	// with the submission handoff (returning
	// before the prompt is in would leave the caller unable to trust the task
	// ever started). true = done-or-blocked; ms = current state on expiry
	// (queued records wait through the queue — handled in 8a).
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
				stance: record.stance,
				worktreePath: record.worktreePath,
				...substrateResultFields(record, routing),
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
			stance: record.stance,
			worktreePath: record.worktreePath,
			waited: true,
			...substrateResultFields(record, routing),
		},
	};
}
