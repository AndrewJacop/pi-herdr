// Tier 1 — Orchestration tools.
// Each tool is a thin wrapper: build argv -> herdr() -> return a uniform ToolReturn.
// `herdr_start_agent` is the end-to-end template; the rest follow the same shape.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { herdr } from "../herdr.js";
import { expandAgentSpec } from "../launcher.js";
import {
	extractText,
	normalizeAgent,
	type Err,
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
				"Explicit launch argv; overrides the preset (required when agent='custom').",
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
 * Drive a spawned agent through one turn using herdr's transition waits:
 * wait for `working` (the turn started), then `idle` (the turn finished).
 * `wait agent-status` waits for a state *change*, which is reliable here because
 * after a submitted prompt the agent transitions idle -> working -> idle.
 *
 * Returns ok on completion, or an error Result whose `message` is "NOT_STARTED"
 * when the turn never entered working (caller may re-send the prompt).
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
	const working = await herdr(
		[
			"wait",
			"agent-status",
			paneId,
			"--status",
			"working",
			"--timeout",
			String(workingBudget),
		],
		{ timeoutMs: workingBudget + 5_000, signal },
	);
	if (!working.ok) {
		return { ok: false, error: { ...working.error, message: "NOT_STARTED" } };
	}
	const idleBudget = Math.max(5_000, opts.deadline - Date.now());
	const idle = await herdr(
		[
			"wait",
			"agent-status",
			paneId,
			"--status",
			"idle",
			"--timeout",
			String(idleBudget),
		],
		{ timeoutMs: idleBudget + 5_000, signal },
	);
	if (!idle.ok) return idle;
	return { ok: true, data: true };
}

// ---- registration ----------------------------------------------------------

export function registerOrchestration(pi: ExtensionAPI): void {
	// 1. start_agent ----------------------------------------------------------
	pi.registerTool({
		name: "herdr_start_agent",
		label: "Start herdr agent",
		description:
			"Launch a new AI agent (pi/claude/codex/...) in a herdr pane and return its pane id and state. " +
			"Platform argv handling (Windows cmd /c wrapper) is automatic.",
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
			const spec = expandAgentSpec({ agent: p.agent, argv: p.argv });
			if (!spec.ok) return fail(spec);
			const name = p.name ?? `agent-${Date.now()}`;
			const args = ["agent", "start", name];
			if (p.cwd) args.push("--cwd", p.cwd);
			if (p.split) args.push("--split", p.split);
			if (p.tabId) args.push("--tab", p.tabId);
			if (p.workspaceId) args.push("--workspace", p.workspaceId);
			if (p.env)
				for (const [k, v] of Object.entries(p.env))
					args.push("--env", `${k}=${v}`);
			args.push(p.focus ? "--focus" : "--no-focus");
			args.push("--", ...spec.data);

			const r = await herdr<{ agent?: Record<string, unknown> }>(args, {
				timeoutMs: 20_000,
				signal,
			});
			if (!r.ok) return fail(r);
			const a = normalizeAgent(r.data?.agent ?? r.data);
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
			const sendR = await herdr(["agent", "send", p.target, p.text], {
				timeoutMs: 15_000,
				signal,
			});
			if (!sendR.ok) return fail(sendR);
			let submitted = false;
			if (p.submit !== false) {
				const enterR = await herdr(["pane", "send-keys", pid.data, "Enter"], {
					timeoutMs: 15_000,
					signal,
				});
				if (!enterR.ok) return fail(enterR);
				submitted = true;
			}
			return okText(
				`Sent prompt to "${p.target}" (pane ${pid.data})${submitted ? " and submitted with Enter" : " (text only, not submitted)"}.`,
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
			return okText(`Agent "${p.target}" reached status "${p.status}".`, {
				paneId: p.target,
				agentStatus: p.status,
			});
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

			// 1. start
			const spec = expandAgentSpec({ agent: p.agent, argv: p.argv });
			if (!spec.ok) return fail(spec);
			const name = p.name ?? `delegate-${Date.now()}`;
			const startArgs = ["agent", "start", name, "--no-focus"];
			if (p.cwd) startArgs.push("--cwd", p.cwd);
			startArgs.push("--", ...spec.data);
			const startR = await herdr<{ agent?: Record<string, unknown> }>(
				startArgs,
				{ timeoutMs: 20_000, signal },
			);
			if (!startR.ok) return fail(startR);
			const paneId =
				(startR.data?.agent as { pane_id?: string })?.pane_id ??
				(startR.data as { pane_id?: string })?.pane_id ??
				null;
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
			const boot = await herdr(
				[
					"wait",
					"agent-status",
					paneId,
					"--status",
					"idle",
					"--timeout",
					"90000",
				],
				{ timeoutMs: 95_000, signal },
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
				const sendR = await herdr(["agent", "send", paneId, p.prompt], {
					timeoutMs: 15_000,
					signal,
				});
				if (!sendR.ok) {
					return partial(
						`Started agent in pane ${paneId} but failed to send the prompt: ${sendR.error.message}`,
						{ paneId, name, error: sendR.error },
					);
				}
				const enterR = await herdr(["pane", "send-keys", paneId, "Enter"], {
					timeoutMs: 15_000,
					signal,
				});
				if (!enterR.ok) {
					return partial(
						`Sent text to pane ${paneId} but failed to submit (Enter): ${enterR.error.message}`,
						{ paneId, name, error: enterR.error },
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
