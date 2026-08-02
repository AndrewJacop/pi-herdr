// Tier 1 — Orchestration tools.
// Each tool is a thin wrapper: build argv -> herdr() -> return a uniform ToolReturn.
// `herdr_start_agent` is the end-to-end template; the rest follow the same shape.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { herdr } from "../herdr.js";
import { expandAgentSpec } from "../launcher.js";
import { detectHerdrVersion, isNewAgentApi } from "../version.js";
import {
	extractText,
	normalizeAgent,
	type Err,
	type HerdrErrorCode,
	type Result,
	type ToolReturn,
} from "../env.js";

const AGENT_PRESETS = ["pi", "claude", "codex", "omp", "custom"] as const;

/** AgentSpec fields reused by start_agent and delegate. */
const agentFields = {
	name: Type.Optional(
		Type.String({
			description:
				"Agent pane name (must be unique). Default: agent-<timestamp>.",
		}),
	),
	agent: Type.Optional(
		StringEnum(AGENT_PRESETS, {
			description:
				"Built-in preset to launch (default 'pi'). Use 'custom' with an explicit argv.",
		}),
	),
	argv: Type.Optional(
		Type.Array(Type.String(), {
			description:
			"Explicit launch argv; overrides the preset (required when agent='custom'). Legacy (<0.7.5) only — rejected on 0.7.5.",
		}),
	),
	agentArgs: Type.Optional(
		Type.Array(Type.String(), {
			description:
			"Extra flags appended to the agent CLI after launch, e.g. [\"-ne\",\"-e\",\"./src/index.ts\"] to load a local extension instead of the installed one. On 0.7.5 these follow `--` in `agent start`; on the Windows pane-run path they join the command line; on legacy they extend the preset argv.",
		}),
	),
	cwd: Type.Optional(
		Type.String({ description: "Working directory for the agent process." }),
	),
};

// ---- small helpers ---------------------------------------------------------

/** Build an error ToolReturn from a non-ok Result. */
function fail(r: Err): ToolReturn {
	return {
		content: [
			{ type: "text", text: `Error (${r.error.code}): ${r.error.message}` },
		],
		details: { error: r.error },
		isError: true,
	};
}

/** Build a success ToolReturn with custom text + structured details. */
function okText(text: string, details: unknown): ToolReturn {
	return { content: [{ type: "text", text }], details };
}

// ---- agent start: version-branched ----------------------------------------
// herdr redesigned `agent start` in 0.7.5. Windows STABLE ships 0.7.3 (legacy
// path); the Windows PREVIEW channel ships 0.7.5, whose `agent start --kind` is
// broken on Windows (Start-Process can't launch npm-shim agents like pi.cmd —
// "%1 is not a valid Win32 application"; with no args it's an empty -ArgumentList).
// We detect the version once and branch:
//   - legacy (<0.7.5): `agent start <name> [--cwd --split --tab --workspace
//     --env] [--focus|--no-focus] -- <argv>` — one call creates the pane.
//   - new (>=0.7.5):  `pane split --current --direction ... [--cwd --env --focus]`
//     then `agent start <name> --kind <kind> --pane <id>` — pane must exist.
//     tab/workspace targeting has no 0.7.5 equivalent (pane split has none), so
//     those are ignored on the new path and the pane lands in the current tab.
//     On Windows the `agent start --kind` step fails (herdr 0.7.5-preview bug),
//     so startAgentNew launches via `pane run` + herdr auto-detect instead.

const NEW_API_KINDS = new Set([
	"pi",
	"claude",
	"codex",
	"gemini",
	"cursor",
	"devin",
	"agy",
	"cline",
	"omp",
	"mastracode",
	"opencode",
	"copilot",
	"kimi",
	"kiro",
	"droid",
	"amp",
	"grok",
	"hermes",
	"kilo",
	"qodercli",
	"maki",
]);

interface StartInput {
	name: string;
	agent?: string;
	argv?: string[];
	agentArgs?: string[]; // extra flags appended to the agent CLI (e.g. ["-ne","-e","./src/index.ts"])
	cwd?: string;
	split?: "right" | "down";
	tabId?: string;
	workspaceId?: string;
	env?: Record<string, string>;
	focus?: boolean;
	signal?: AbortSignal;
}

/** Build a non-ok Result with a normalized error code. */
function err(code: HerdrErrorCode, message: string, details?: unknown): Err {
	return { ok: false, error: { code, message, details } };
}

/** Tolerantly pull a pane id out of a `pane split` / `agent start` result. */
function extractPaneId(d: unknown): string | undefined {
	if (!d || typeof d !== "object") return undefined;
	const o = d as Record<string, unknown>;
	const pane =
		o.pane && typeof o.pane === "object"
			? (o.pane as Record<string, unknown>)
			: o;
	for (const k of ["pane_id", "paneId", "id"]) {
		if (typeof pane[k] === "string") return pane[k] as string;
	}
	return undefined;
}

/** Legacy (<0.7.5) launch: one `agent start` that creates and configures the pane. */
async function startAgentLegacy(
	input: StartInput,
): Promise<Result<{ agent: Record<string, unknown> }>> {
	const spec = expandAgentSpec({ agent: input.agent, argv: input.argv });
	if (!spec.ok) return spec;
	const args = ["agent", "start", input.name];
	if (input.cwd) args.push("--cwd", input.cwd);
	if (input.split) args.push("--split", input.split);
	if (input.tabId) args.push("--tab", input.tabId);
	if (input.workspaceId) args.push("--workspace", input.workspaceId);
	if (input.env)
		for (const [k, v] of Object.entries(input.env))
			args.push("--env", `${k}=${v}`);
	args.push(input.focus ? "--focus" : "--no-focus");	// legacy `agent start -- <argv>`: preset argv, then any extra agent flags.
	args.push("--", ...spec.data, ...(input.agentArgs ?? []));
	const r = await herdr<{ agent?: Record<string, unknown> }>(args, {
		timeoutMs: 20_000,
		signal: input.signal,
	});
	if (!r.ok) return r;
	return {
		ok: true,
		data: { agent: (r.data?.agent ?? r.data) as Record<string, unknown> },
	};
}

/** New (>=0.7.5) launch: split a pane, then attach an agent to it by --kind. */
async function startAgentNew(
	input: StartInput,
): Promise<Result<{ agent: Record<string, unknown> }>> {
	// 0.7.5 `agent start` takes --kind, not a raw command.
	if (input.argv && input.argv.length) {
		return err(
			"VALIDATION_ERROR",
			"herdr 0.7.5+ `agent start` requires --kind and cannot run a custom argv; use a named preset (pi/claude/codex/omp).",
		);
	}
	const kind = (input.agent ?? "pi").toLowerCase();
	if (!NEW_API_KINDS.has(kind)) {
		return err(
			"VALIDATION_ERROR",
			`herdr 0.7.5+ \`agent start\` has no --kind for preset "${kind}". Supported: ${[...NEW_API_KINDS].join(", ")}.`,
		);
	}

	// 1. create the pane (0.7.5 `agent start` needs an existing pane at a shell prompt).
	const splitArgs = [
		"pane",
		"split",
		"--current",
		"--direction",
		input.split ?? "right",
	];
	if (input.cwd) splitArgs.push("--cwd", input.cwd);
	if (input.env)
		for (const [k, v] of Object.entries(input.env))
			splitArgs.push("--env", `${k}=${v}`);
	if (input.focus) splitArgs.push("--focus");
	const splitR = await herdr<unknown>(splitArgs, {
		timeoutMs: 20_000,
		signal: input.signal,
	});
	if (!splitR.ok) return splitR;
	const paneId = extractPaneId(splitR.data);
	if (!paneId) {
		return err(
			"PANE_GONE",
			"herdr pane split returned no pane id",
			splitR.data,
		);
	}

	// 2. attach the agent to the pane. herdr 0.7.5-preview's `agent start --kind`
	//    is broken on Windows (Start-Process can't launch npm-shim agents — "%1
	//    is not a valid Win32 application"), so on Windows launch the bare agent
	//    command via `pane run` and let herdr auto-detect it (validated e2e). On
	//    macOS/Linux `agent start --kind` works but fails fast with
	//    `agent_pane_busy` while the freshly-split shell reaches its prompt, so
	//    retry briefly.
	if (process.platform === "win32") {
		return startAgentWindowsPaneRun(input, paneId);
	}
	const startArgs = [
		"agent",
		"start",
		input.name,
		"--kind",
		kind,
		"--pane",
		paneId,
	];
	// 0.7.5 `agent start ... -- <agent-args>`: pass native agent flags (e.g. pi's
	// `-e ./src/index.ts`) so a spawned agent can load a local extension.
	if (input.agentArgs?.length) startArgs.push("--", ...input.agentArgs);
	const deadline = Date.now() + 6_000;
	let startR: Result<{ agent?: Record<string, unknown> }>;
	do {
		startR = await herdr<{ agent?: Record<string, unknown> }>(startArgs, {
			timeoutMs: 20_000,
			signal: input.signal,
		});
		if (startR.ok) break;
		const code = (startR.error.details as { code?: string } | undefined)?.code;
		if (code !== "agent_pane_busy" || Date.now() >= deadline) break;
		await sleep(250);
	} while (true);
	if (!startR.ok) return startR;
	return {
		ok: true,
		data: {
			agent: (startR.data?.agent ?? { pane_id: paneId }) as Record<
				string,
				unknown
			>,
		},
	};
}

/**
 * Windows launch fallback for herdr 0.7.5-preview, whose `agent start --kind` is
 * broken (Start-Process can't launch npm-shim agents like pi.cmd — "%1 is not a
 * valid Win32 application"). Launch the BARE agent command via `pane run` — the
 * pane's shell resolves the .cmd shim (PATHEXT) — wait for herdr to auto-detect
 * it, then name the pane.
 *
 * Use the bare command (e.g. "pi"), NOT the `cmd /c` wrapper: the wrapper nests
 * a shell and herdr's auto-detection then sees `cmd`, not the agent.
 *
 * ponytail: platform-gated. When herdr fixes Windows `agent start --kind`, revisit
 * to use it (gives proper --kind/session registration); until then pane-run is the
 * only working Windows launch, and all tools (prompt/get/read/rename/close) work
 * on the auto-detected pane.
 */
async function startAgentWindowsPaneRun(
	input: StartInput,
	paneId: string,
): Promise<Result<{ agent: Record<string, unknown> }>> {
	const spec = expandAgentSpec({ agent: input.agent });
	if (!spec.ok) return spec;
	const bareCmd = spec.data[spec.data.length - 1];
	// `pane run <pane> <command>` takes one command string (text + Enter); join
	// the bare agent command with any extra flags into a single command line.
	const cmdLine = input.agentArgs?.length
		? [bareCmd, ...input.agentArgs].join(" ")
		: bareCmd;
	const runR = await herdr(["pane", "run", paneId, cmdLine], {
		timeoutMs: 15_000,
		signal: input.signal,
	});
	if (!runR.ok) return runR;
	// Wait for herdr to detect the agent (agent get stops returning agent_not_found).
	const detected = await waitForAgentDetected(paneId, 20_000, input.signal);
	if (!detected.ok) return detected;
	// Name the pane (best-effort; `agent start` would have taken <name>).
	await herdr(["agent", "rename", paneId, input.name], {
		timeoutMs: 10_000,
		signal: input.signal,
	});
	return {
		ok: true,
		data: { agent: { pane_id: paneId } },
	};
}

/** Poll `agent get` until herdr tracks the pane as an agent (or budget expires). */
async function waitForAgentDetected(
	paneId: string,
	budgetMs: number,
	signal?: AbortSignal,
): Promise<Result<true>> {
	const deadline = Date.now() + budgetMs;
	while (Date.now() < deadline) {
		const r = await herdr(["agent", "get", paneId], {
			timeoutMs: 8_000,
			signal,
		});
		if (r.ok) return { ok: true, data: true };
		await sleep(500);
	}
	return err(
		"AGENT_START_FAILED",
		`agent in pane ${paneId} was not detected by herdr within ${budgetMs}ms`,
	);
}

/** Detect herdr version once and dispatch to the matching launch path. */
async function startHerdrAgent(
	input: StartInput,
): Promise<Result<{ agent: Record<string, unknown> }>> {
	const version = await detectHerdrVersion();
	return isNewAgentApi(version)
		? startAgentNew(input)
		: startAgentLegacy(input);
}

/**
 * Type (and optionally submit) a prompt into an agent pane. herdr 0.7.5 replaced
 * `agent send` with `agent prompt` (type + submit in one call) and pane-level
 * `send-text` (type only); legacy keeps `agent send` + `pane send-keys Enter`.
 */
async function sendAgentPrompt(
	paneId: string,
	text: string,
	opts: { submit?: boolean; signal?: AbortSignal } = {},
): Promise<Result<true>> {
	const submit = opts.submit !== false;
	const version = await detectHerdrVersion();
	if (isNewAgentApi(version)) {
		const r = submit
			? await herdr(["agent", "prompt", paneId, text], {
					timeoutMs: 15_000,
					signal: opts.signal,
				})
			: await herdr(["pane", "send-text", paneId, text], {
					timeoutMs: 15_000,
					signal: opts.signal,
				});
		return r.ok ? { ok: true, data: true } : r;
	}
	const sendR = await herdr(["agent", "send", paneId, text], {
		timeoutMs: 15_000,
		signal: opts.signal,
	});
	if (!sendR.ok) return sendR;
	if (submit) {
		const enterR = await herdr(["pane", "send-keys", paneId, "Enter"], {
			timeoutMs: 15_000,
			signal: opts.signal,
		});
		if (!enterR.ok) return enterR;
	}
	return { ok: true, data: true };
}

/** Resolve a flexible target (name/label/paneId) to a concrete pane id. */
async function resolvePaneId(
	target: string,
	signal?: AbortSignal,
): Promise<Result<string>> {
	const r = await herdr<unknown>(["agent", "get", target], {
		timeoutMs: 10_000,
		signal,
	});
	if (!r.ok) return r as Result<string>;
	const a =
		(r.data as { agent?: Record<string, unknown> })?.agent ??
		(r.data as Record<string, unknown>);
	const pid = (a?.pane_id as string) ?? (a?.paneId as string);
	if (!pid) {
		return {
			ok: false,
			error: {
				code: "NOT_FOUND",
				message: `No pane found for target "${target}"`,
				details: r.data,
			},
		};
	}
	return { ok: true, data: pid };
}

const sleep = (ms: number): Promise<void> =>
	new Promise((r) => setTimeout(r, ms));

/**
 * Wait for a pane to reach idle OR done, whichever fires first, by racing two
 * transition waits.
 *
 * Why race: a pi pane that loads this extension self-reports its state
 * (src/selfreport.ts), and herdr renders a self-reported idle-after-working as
 * `done`; a pane without self-report is auto-detected and settles on `idle`.
 * Racing both covers each path. We do NOT infer completion from the rendered
 * spinner — that's unreliable because tool-call output replaces the spinner in
 * the viewport, which previously caused premature "idle" reports mid-work.
 *
 * If neither transition fires (e.g. an unequipped agent where herdr missed the
 * transition), both waits time out and we return TIMEOUT — the caller then
 * reads whatever partial output exists.
 */
/**
 * Wait for `paneId` to reach one of `statuses`.
 *
 * Prefers herdr's event-based `wait agent-status` (prompt, no polling), but races
 * it against a polling fallback (`agent get`) because `wait agent-status` is
 * unreliable on some herdr builds (e.g. 0.7.3 returns `failed to decode pane get
 * error` on its probe step). The event promise resolves ONLY on success — on
 * error it stays pending so the poll decides. Whichever path sees a target
 * status first wins; the other is cancelled. The poll is what makes completion
 * detection robust instead of depending on a flaky event command.
 */
async function waitForStatus(
	paneId: string,
	statuses: string[],
	deadline: number,
	signal?: AbortSignal,
): Promise<Result<true>> {
	const budget = Math.max(1_000, deadline - Date.now());
	const want = new Set(statuses);
	const ctrl = new AbortController();
	const onParentAbort = () => ctrl.abort();
	if (signal) {
		if (signal.aborted) {
			return { ok: false, error: { code: "TIMEOUT", message: "aborted" } };
		}
		signal.addEventListener("abort", onParentAbort, { once: true });
	}
	type Resolved = { via: "event" | "poll"; r: Result<true> };
	// Event path: resolves only on a successful transition (errors swallowed so
	// the polling fallback gets to run).
	const events = new Promise<Resolved>((resolve) => {
		for (const s of statuses) {
			herdr(
				[
					"wait",
					"agent-status",
					paneId,
					"--status",
					s,
					"--timeout",
					String(budget),
				],
				{ timeoutMs: budget + 5_000, signal: ctrl.signal },
			).then((r) => {
				if (r.ok) resolve({ via: "event", r: { ok: true, data: true } });
			});
		}
	});
	// Polling fallback: `agent get` is reliable when `wait agent-status` misbehaves.
	const poll: Promise<Resolved> = (async () => {
		while (Date.now() < deadline) {
			if (ctrl.signal.aborted) {
				return {
					via: "poll",
					r: { ok: false, error: { code: "TIMEOUT", message: "aborted" } },
				};
			}
			const r = await herdr<{
				agent?: { agent_status?: string };
				agent_status?: string;
			}>(["agent", "get", paneId], { timeoutMs: 8_000, signal: ctrl.signal });
			if (r.ok) {
				const st = (r.data?.agent ?? r.data)?.agent_status;
				if (st && want.has(st)) {
					return { via: "poll", r: { ok: true, data: true } };
				}
			}
			await sleep(800);
		}
		return {
			via: "poll",
			r: {
				ok: false,
				error: {
					code: "TIMEOUT",
					message: `timed out polling for ${statuses.join("/")}`,
				},
			},
		};
	})();
	try {
		const first = await Promise.race([events, poll]);
		ctrl.abort(); // cancel the still-running path
		return first.r;
	} finally {
		if (signal) signal.removeEventListener("abort", onParentAbort);
	}
}

/**
 * Wait for a pane to reach idle OR done, whichever fires first.
 * Self-report yields `idle` on herdr ≥0.7.3 (which no longer derives `done`);
 * older builds derived `done`. waitForStatus races the event against a poll.
 */
async function raceIdleDone(
	paneId: string,
	deadline: number,
	signal?: AbortSignal,
): Promise<Result<true>> {
	return waitForStatus(paneId, ["idle", "done"], deadline, signal);
}

/**
 * Drive a spawned agent through one turn.
 *
 * Phase 1 (start): `wait agent-status working` — herdr's idle->working
 * transition is reliable (both auto-detect and self-report).
 *
 * Phase 2 (finish): race `idle`/`done` (see raceIdleDone). Completion relies on
 * self-report (the reliable signal) or herdr's auto-detect; we never force the
 * state ourselves, so we can't report a still-working pane as idle.
 *
 * Returns ok on completion, or an error whose `message` is "NOT_STARTED" when
 * the turn never entered working (caller may re-send the prompt).
 */
async function driveOneTurn(
	paneId: string,
	opts: { deadline: number; workingWindowMs?: number; signal?: AbortSignal },
): Promise<Result<true>> {
	const { signal } = opts;
	const workingBudget = Math.min(
		opts.workingWindowMs ?? 30_000,
		Math.max(2_000, opts.deadline - Date.now()),
	);
	const working = await waitForStatus(
		paneId,
		["working"],
		Date.now() + workingBudget,
		signal,
	);
	if (!working.ok) {
		return { ok: false, error: { ...working.error, message: "NOT_STARTED" } };
	}
	return raceIdleDone(paneId, opts.deadline, signal);
}

// ---- registration ----------------------------------------------------------

export function registerOrchestration(pi: ExtensionAPI): void {
	// 1. start_agent ----------------------------------------------------------
	pi.registerTool({
		name: "herdr_start_agent",
		label: "Start herdr agent",
		description:
			"Launch a new AI agent (pi/claude/codex/...) in a herdr pane and return its pane id and state. " +
			"Platform argv handling (Windows cmd /c wrapper) is automatic. " +
			"Pass agentArgs (e.g. [\"-ne\",\"-e\",\"./src/index.ts\"]) to give the agent CLI extra flags — used to load a local extension instead of the installed one.",
		promptSnippet:
			"Spawn a herdr agent pane (pi/claude/codex/...) and drive it",
		promptGuidelines: [
			"Use herdr_start_agent to run another AI agent in a visible herdr pane; use herdr_delegate for one-shot spawn→send→wait→read.",
		],
		parameters: Type.Object({
			...agentFields,
			split: Type.Optional(
				StringEnum(["right", "down"] as const, {
					description: "Split direction relative to the current pane.",
				}),
			),
			tabId: Type.Optional(
				Type.String({ description: "Target tab id, e.g. 'w1:t1'." }),
			),
			workspaceId: Type.Optional(
				Type.String({ description: "Target workspace id, e.g. 'w1'." }),
			),
			env: Type.Optional(
				Type.Record(Type.String(), Type.String(), {
					description: "Extra env vars (KEY=VALUE) for the agent.",
				}),
			),
			focus: Type.Optional(
				Type.Boolean({ description: "Focus the new pane (default false)." }),
			),
		}),
		async execute(_id, p, signal) {
			const name = p.name ?? `agent-${Date.now()}`;
			const r = await startHerdrAgent({
				name,
				agent: p.agent,
				argv: p.argv,
				agentArgs: p.agentArgs,
				cwd: p.cwd,
				split: p.split,
				tabId: p.tabId,
				workspaceId: p.workspaceId,
				env: p.env,
				focus: p.focus,
				signal,
			});
			if (!r.ok) return fail(r);
			const a = normalizeAgent(r.data.agent);
			return okText(
				`Started ${a.agent ?? p.agent ?? "pi"} agent "${a.name ?? name}" in pane ${a.paneId ?? "?"}.`,
				a,
			);
		},
	});

	// 2. send_prompt ----------------------------------------------------------
	pi.registerTool({
		name: "herdr_send_prompt",
		label: "Send prompt to herdr agent",
		description:
			"Send a prompt to an agent pane. With submit=true (default) the text is also submitted (Enter). " +
			"Use to drive an agent you started with herdr_start_agent.",
		promptSnippet: "Send/submit a prompt to a running herdr agent pane",
		promptGuidelines: [
			"Use herdr_send_prompt to send a prompt to an agent pane, then herdr_wait_agent + herdr_read_agent to get the reply.",
		],
		parameters: Type.Object({
			target: Type.String({
				description: "Pane id (w1:p3), agent name, or label.",
			}),
			text: Type.String({ description: "Prompt text to type." }),
			submit: Type.Optional(
				Type.Boolean({ description: "Press Enter to submit (default true)." }),
			),
		}),
		async execute(_id, p, signal) {
			const pid = await resolvePaneId(p.target, signal);
			if (!pid.ok) return fail(pid);
			const submitted = p.submit !== false;
			const sendR = await sendAgentPrompt(pid.data, p.text, {
				submit: submitted,
				signal,
			});
			if (!sendR.ok) return fail(sendR);
			return okText(
				`Sent prompt to "${p.target}" (pane ${pid.data})${submitted ? " and submitted" : " (text only, not submitted)"}.`,
				{ paneId: pid.data, submitted },
			);
		},
	});

	// 3. read_agent -----------------------------------------------------------
	pi.registerTool({
		name: "herdr_read_agent",
		label: "Read herdr agent output",
		description:
			"Read recent/visible output text from an agent pane. Returns the text and whether it was truncated.",
		promptSnippet: "Read an agent pane's output text",
		promptGuidelines: [
			"Use herdr_read_agent to fetch an agent's response after herdr_wait_agent reports idle.",
		],
		parameters: Type.Object({
			target: Type.String({ description: "Pane id, agent name, or label." }),
			source: Type.Optional(
				StringEnum(["recent", "visible", "recent-unwrapped"] as const, {
					description: "Output source (default 'recent').",
				}),
			),
			lines: Type.Optional(
				Type.Integer({ description: "Max lines to read (default 50)." }),
			),
			format: Type.Optional(
				StringEnum(["text", "ansi"] as const, {
					description: "Output format (default 'text').",
				}),
			),
		}),
		async execute(_id, p, signal) {
			const source = p.source ?? "recent";
			const lines = p.lines ?? 50;
			const format = p.format ?? "text";
			const r = await herdr<unknown>(
				[
					"agent",
					"read",
					p.target,
					"--source",
					source,
					"--lines",
					String(lines),
					"--format",
					format,
				],
				{ timeoutMs: 15_000, signal, textOk: true },
			);
			if (!r.ok) return fail(r);
			const text = extractText(r.data);
			const truncated = Boolean((r.data as { truncated?: boolean })?.truncated);
			return okText(text || "(no output)", {
				paneId: p.target,
				text,
				truncated,
			});
		},
	});

	// 4. wait_agent -----------------------------------------------------------
	pi.registerTool({
		name: "herdr_wait_agent",
		label: "Wait for herdr agent status",
		description:
			"Block until an agent pane reaches a given status (idle/working/blocked/done). " +
			"Tolerates the brief 'unknown' window right after spawn. Returns TIMEOUT on expiry.",
		promptSnippet: "Wait for an agent pane to reach idle/working/blocked",
		promptGuidelines: [
			"Use herdr_wait_agent to block until an agent finishes a turn (status idle), then read its output.",
		],
		parameters: Type.Object({
			target: Type.String({ description: "Pane id, agent name, or label." }),
			status: StringEnum(
				["idle", "working", "blocked", "done", "unknown"] as const,
				{
					description: "Status to wait for.",
				},
			),
			timeoutMs: Type.Optional(
				Type.Integer({ description: "Max wait in ms (default 60000)." }),
			),
		}),
		async execute(_id, p, signal) {
			const timeoutMs = p.timeoutMs ?? 60_000;
			const reached = (msg: string, agentStatus: string): ToolReturn =>
				okText(msg, { paneId: p.target, agentStatus });
			// idle/done: race the transition waits. Self-report yields `done`, auto-
			// detect yields `idle`; we wait for whichever fires first.
			if (p.status === "idle" || p.status === "done") {
				const r = await raceIdleDone(p.target, Date.now() + timeoutMs, signal);
				if (!r.ok) return fail(r);
				return reached(
					`Agent "${p.target}" reached status "${p.status}".`,
					p.status,
				);
			}
			// working/blocked/unknown: herdr's transition wait.
			const r = await herdr<unknown>(
				[
					"wait",
					"agent-status",
					p.target,
					"--status",
					p.status,
					"--timeout",
					String(timeoutMs),
				],
				{ timeoutMs: timeoutMs + 8_000, signal },
			);
			if (!r.ok) return fail(r);
			return reached(
				`Agent "${p.target}" reached status "${p.status}".`,
				p.status,
			);
		},
	});

	// 5. list_agents ----------------------------------------------------------
	pi.registerTool({
		name: "herdr_list_agents",
		label: "List herdr agents",
		description:
			"List all agents currently running in herdr with their status.",
		promptSnippet: "List all herdr agent panes and their statuses",
		promptGuidelines: [
			"Use herdr_list_agents to see what agent panes exist and their idle/working status.",
		],
		parameters: Type.Object({}),
		async execute(_id, _p, signal) {
			const r = await herdr<{ agents?: Record<string, unknown>[] }>(
				["agent", "list"],
				{
					timeoutMs: 10_000,
					signal,
				},
			);
			if (!r.ok) return fail(r);
			const agents = (r.data?.agents ?? []).map(normalizeAgent);
			return okText(
				agents.length
					? `${agents.length} agent(s):\n` +
							agents
								.map(
									(a) =>
										`- ${a.paneId ?? "?"} [${a.agentStatus ?? "?"}] ${a.name ?? ""} (${a.agent ?? "?"})`,
								)
								.join("\n")
					: "No agents running.",
				{ agents },
			);
		},
	});

	// 6. get_agent ------------------------------------------------------------
	pi.registerTool({
		name: "herdr_get_agent",
		label: "Get herdr agent",
		description: "Get details of a single agent pane by id/name/label.",
		promptSnippet: "Get one agent pane's details",
		parameters: Type.Object({
			target: Type.String({ description: "Pane id, agent name, or label." }),
		}),
		async execute(_id, p, signal) {
			const r = await herdr<{ agent?: Record<string, unknown> }>(
				["agent", "get", p.target],
				{
					timeoutMs: 10_000,
					signal,
				},
			);
			if (!r.ok) return fail(r);
			const a = normalizeAgent(r.data?.agent ?? r.data);
			return okText(
				`Agent "${a.name ?? p.target}" (${a.agent ?? "?"}): pane ${a.paneId ?? "?"}, status ${a.agentStatus ?? "?"}.`,
				a,
			);
		},
	});

	// 7. stop_agent (destructive) --------------------------------------------
	pi.registerTool({
		name: "herdr_stop_agent",
		label: "Stop herdr agent",
		description:
			"⚠️ Destructive. Close an agent's pane (terminates the agent). Use when an agent is stuck or no longer needed.",
		promptSnippet: "Close/stop a herdr agent pane (destructive)",
		promptGuidelines: [
			"Use herdr_stop_agent to close an agent pane; it terminates that agent process.",
		],
		parameters: Type.Object({
			target: Type.String({ description: "Pane id, agent name, or label." }),
		}),
		async execute(_id, p, signal) {
			const pid = await resolvePaneId(p.target, signal);
			if (!pid.ok) return fail(pid);
			const r = await herdr(["pane", "close", pid.data], {
				timeoutMs: 10_000,
				signal,
			});
			if (!r.ok) return fail(r);
			return okText(`Closed pane ${pid.data} ("${p.target}").`, {
				paneId: pid.data,
				stopped: true,
			});
		},
	});

	// 8. rename_agent ---------------------------------------------------------
	pi.registerTool({
		name: "herdr_rename_agent",
		label: "Rename herdr agent",
		description: "Rename an agent pane, or clear its name.",
		promptSnippet: "Rename (or clear the name of) a herdr agent pane",
		parameters: Type.Object({
			target: Type.String({ description: "Pane id, agent name, or label." }),
			name: Type.Optional(
				Type.String({
					description: "New name; omit or set empty to clear the name.",
				}),
			),
		}),
		async execute(_id, p, signal) {
			const newName = p.name && p.name.length ? p.name : null;
			const r = await herdr(
				["agent", "rename", p.target, ...(newName ? [newName] : ["--clear"])],
				{
					timeoutMs: 10_000,
					signal,
				},
			);
			if (!r.ok) return fail(r);
			return okText(`Renamed "${p.target}" -> "${newName ?? "(cleared)"}".`, {
				paneId: p.target,
				name: newName,
			});
		},
	});

	// 9. focus_agent ----------------------------------------------------------
	pi.registerTool({
		name: "herdr_focus_agent",
		label: "Focus herdr agent",
		description: "Focus an agent pane in the herdr UI.",
		promptSnippet: "Focus a herdr agent pane",
		parameters: Type.Object({
			target: Type.String({ description: "Pane id, agent name, or label." }),
		}),
		async execute(_id, p, signal) {
			const r = await herdr(["agent", "focus", p.target], {
				timeoutMs: 10_000,
				signal,
			});
			if (!r.ok) return fail(r);
			return okText(`Focused pane "${p.target}".`, {
				paneId: p.target,
				focused: true,
			});
		},
	});

	// 10. explain_agent -------------------------------------------------------
	pi.registerTool({
		name: "herdr_explain_agent",
		label: "Explain herdr agent",
		description:
			"Get a natural-language explanation of what an agent pane is/does.",
		promptSnippet: "Explain what a herdr agent pane is doing",
		parameters: Type.Object({
			target: Type.String({ description: "Pane id, agent name, or label." }),
		}),
		async execute(_id, p, signal) {
			const r = await herdr<unknown>(["agent", "explain", p.target], {
				timeoutMs: 15_000,
				signal,
				textOk: true,
			});
			if (!r.ok) return fail(r);
			const explanation = extractText(r.data);
			return okText(explanation || "(no explanation)", {
				target: p.target,
				explanation,
			});
		},
	});

	// 11. delegate (composite) ------------------------------------------------
	// start -> wait idle (boot) -> send(submit) -> wait working -> wait idle -> read.
	// Best-effort: the working-wait may be skipped if the turn is very short.
	pi.registerTool({
		name: "herdr_delegate",
		label: "Delegate to a herdr agent (one-shot)",
		description:
			"Spawn a fresh agent, send a prompt, wait for it to finish, and return its response text — " +
			"all in one call. The default is to keep the pane alive for follow-ups (set closeOnSuccess to close it).",
		promptSnippet:
			"One-shot delegate: spawn an agent, send a prompt, wait, return its reply",
		promptGuidelines: [
			"Use herdr_delegate for one-shot delegation: it spawns an agent, sends the prompt, waits for idle, and returns the response.",
		],
		parameters: Type.Object({
			...agentFields,
			prompt: Type.String({
				description: "Prompt to send to the spawned agent.",
			}),
			timeoutMs: Type.Optional(
				Type.Integer({ description: "Overall budget in ms (default 120000)." }),
			),
			closeOnSuccess: Type.Optional(
				Type.Boolean({
					description:
						"Close the pane after a successful response (default false, keep alive).",
				}),
			),
			env: Type.Optional(
				Type.Record(Type.String(), Type.String(), {
					description:
						"Extra env vars (KEY=VALUE) for the agent. On macOS set PATH to your " +
						"shell PATH if herdr's server runs with launchd's minimal PATH " +
						"(e.g. via `brew services`), so a node-based agent like `pi` can find `node`.",
				}),
			),
		}),
		async execute(_id, p, signal) {
			const overall = p.timeoutMs ?? 120_000;
			const startedAt = Date.now();
			const left = () => Math.max(2_000, overall - (Date.now() - startedAt));

			const partial = (
				message: string,
				extra: Record<string, unknown>,
				isError = true,
			): ToolReturn => ({
				content: [{ type: "text", text: message }],
				details: { ...extra },
				isError,
			});

			// 1. start (version-branched: legacy 0.7.3 vs redesigned 0.7.5 agent start)
			const name = p.name ?? `delegate-${Date.now()}`;
			const startR = await startHerdrAgent({
				name,
				agent: p.agent,
				argv: p.argv,
				agentArgs: p.agentArgs,
				cwd: p.cwd,
				env: p.env,
				signal,
			});
			if (!startR.ok) return fail(startR);
			const paneId = normalizeAgent(startR.data.agent).paneId ?? null;
			if (!paneId) {
				return partial("agent start returned no pane id", {
					name,
					agent: p.agent,
					error: startR.data,
				});
			}

			// 2. boot gate: wait for the boot idle transition. A spawned pi that inherits
			//    the host's extensions/skills can spend ~40-60s in `unknown` before
			//    reaching idle, so use a generous timeout and CHECK it (don't send until
			//    the agent is actually idle/ready).
			const boot = await waitForStatus(
				paneId,
				["idle"],
				Date.now() + 90_000,
				signal,
			);
			if (!boot.ok) {
				return partial(
					`Agent in pane ${paneId} did not become idle (boot) within budget: ${boot.error.message}`,
					{ paneId, name, error: boot.error },
				);
			}
			await sleep(1500); // brief settle so the TUI input is ready (PRD §2.2)

			// 3-5. send + submit, then drive the turn (working -> idle). Re-send if the
			//      turn never starts (the prompt can be lost if sent too early).
			const turnDeadline = Date.now() + left();
			let done: Result<true> = {
				ok: false,
				error: { code: "TIMEOUT", message: "no send attempt was made" },
			};
			for (
				let attempt = 0;
				attempt < 3 && Date.now() < turnDeadline;
				attempt++
			) {
				if (attempt > 0) await sleep(2_000); // brief pause before re-sending
				const sendR = await sendAgentPrompt(paneId, p.prompt, {
					submit: true,
					signal,
				});
				if (!sendR.ok) {
					return partial(
						`Started agent in pane ${paneId} but failed to send the prompt: ${sendR.error.message}`,
						{ paneId, name, error: sendR.error },
					);
				}
				done = await driveOneTurn(paneId, {
					deadline: turnDeadline,
					workingWindowMs: 30_000,
					signal,
				});
				if (done.ok) break;
				if (done.error.message !== "NOT_STARTED") break; // only retry when the turn never started
			}

			// 6. read (always attempt, even on timeout, to grab partial output)
			const readR = await herdr<unknown>(
				[
					"agent",
					"read",
					paneId,
					"--source",
					"recent",
					"--lines",
					"50",
					"--format",
					"text",
				],
				{ timeoutMs: 15_000, signal, textOk: true },
			);
			const response = readR.ok ? extractText(readR.data) : "";

			if (!done.ok) {
				return partial(
					`Timed out waiting for agent to finish. Partial response from pane ${paneId}:\n${response || "(none)"}`,
					{ paneId, name, response, error: done.error },
				);
			}

			// 7. closeOnSuccess
			if (p.closeOnSuccess) {
				await herdr(["pane", "close", paneId], { timeoutMs: 15_000, signal });
			}

			return okText(response || "(agent produced no captured output)", {
				paneId,
				name,
				response,
				closed: Boolean(p.closeOnSuccess),
			});
		},
	});
}
