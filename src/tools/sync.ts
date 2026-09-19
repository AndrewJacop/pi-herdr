// Pane-sync quartet — the "run a command in a pane" unlock (kept whole by
// the v0.6 surface cut, wayfinder ticket 09): `herdr_run_command`,
// `herdr_read_pane`, `herdr_wait_output`, `herdr_send_keys`. Raw pane control,
// option-list answers, fallback reads — the surface herdr splits from the
// agent surface: non-agent panes (`heroku logs --tail`, a test suite, a
// build) are driven here, addressing an EXISTING pane by id (panes come from
// the herdr UI, not from the model — pane/tab/workspace CRUD is off the
// surface).
//
// Each tool is a thin wrapper: build argv -> herdr() -> uniform ToolReturn,
// mirroring orchestration.ts. `pane send-keys` / `agent send-keys` send
// LOGICAL key names (ctrl+c, esc, Enter) — use `herdr_run_command` /
// `herdr_send_prompt` to type text.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { herdr } from "../herdr.js";
import {
	extractText,
	type Err,
	type HerdrErrorCode,
	type ToolReturn,
} from "../env.js";

// ---- small helpers (mirror orchestration.ts) ------------------------------

/** Build a non-ok Result with a normalized error code. */
function err(code: HerdrErrorCode, message: string, details?: unknown): Err {
	return { ok: false, error: { code, message, details } };
}

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

/**
 * Build the `pane wait-output` argv. Pure (no I/O) so the match/regex/flag
 * branching is unit-testable offline.
 *
 * Exactly one of `match` / `regex` is required (the caller validates). `--timeout`
 * is always emitted (herdr waits indefinitely without it; "Timeouts everywhere"
 * per CONTRIBUTING).
 */
export function waitOutputArgs(
	paneId: string,
	opts: {
		match?: string;
		regex?: string;
		source?: string;
		lines?: number;
		timeoutMs?: number;
		raw?: boolean;
	},
): string[] {
	const args = ["pane", "wait-output", paneId];
	args.push(opts.regex ? "--regex" : "--match", opts.regex ?? opts.match ?? "");
	if (opts.source) args.push("--source", opts.source);
	if (opts.lines != null) args.push("--lines", String(opts.lines));
	args.push("--timeout", String(opts.timeoutMs ?? 30_000));
	if (opts.raw) args.push("--raw");
	return args;
}

// ---- registration ----------------------------------------------------------

export function registerPaneSync(pi: ExtensionAPI): void {
	// 1. run_command ----------------------------------------------------------
	pi.registerTool({
		name: "herdr_run_command",
		label: "Run command in herdr pane",
		description:
			"Run a shell command (text + Enter) in a herdr pane — a raw process, not an agent. " +
			"Use for logs, test suites, builds, one-off shell commands.",
		promptSnippet: "Run a shell command in a herdr pane (text + Enter)",
		promptGuidelines: [
			"Use herdr_run_command to run shell commands (logs, tests, builds) in an existing raw pane (by pane id); read the result with herdr_read_pane.",
		],
		parameters: Type.Object({
			paneId: Type.String({ description: "Target pane id (e.g. 'w1:p3')." }),
			command: Type.String({
				description: "Command line to run (typed, then Enter).",
			}),
		}),
		async execute(_id, p, signal) {
			// `pane run <pane> <command>` takes the command as one argv element
			// (text + Enter): the pane's shell types the line and submits it.
			const r = await herdr(["pane", "run", p.paneId, p.command], {
				timeoutMs: 15_000,
				signal,
			});
			if (!r.ok) return fail(r);
			return okText(`Ran command in pane ${p.paneId}: ${p.command}`, {
				paneId: p.paneId,
				command: p.command,
			});
		},
	});

	// 2. read_pane ------------------------------------------------------------
	pi.registerTool({
		name: "herdr_read_pane",
		label: "Read herdr pane output",
		description:
			"Read recent/visible terminal output from a herdr pane (raw terminal, not an agent). " +
			"Returns the text and whether it was truncated.",
		promptSnippet: "Read a herdr pane's terminal output",
		promptGuidelines: [
			"Use herdr_read_pane to fetch a raw pane's output after herdr_run_command or herdr_wait_output.",
		],
		parameters: Type.Object({
			paneId: Type.String({ description: "Target pane id." }),
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
					"pane",
					"read",
					p.paneId,
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
				paneId: p.paneId,
				text,
				truncated,
			});
		},
	});

	// 3. wait_output ----------------------------------------------------------
	pi.registerTool({
		name: "herdr_wait_output",
		label: "Wait for herdr pane output",
		description:
			"Block until a herdr pane emits output matching a literal substring (--match) or a regex (--regex). " +
			"Searches existing output, then polls. Returns the matched line. Useful for waiting on a server 'ready' marker.",
		promptSnippet: "Wait until a herdr pane emits matching output",
		promptGuidelines: [
			"Use herdr_wait_output to block until a pane prints an expected line (e.g. a server 'ready' marker) after herdr_run_command.",
		],
		parameters: Type.Object({
			paneId: Type.String({ description: "Target pane id." }),
			match: Type.Optional(
				Type.String({
					description: "Literal substring to match (mutually exclusive with regex).",
				}),
			),
			regex: Type.Optional(
				Type.String({
					description: "Rust regex to match (mutually exclusive with match).",
				}),
			),
			source: Type.Optional(
				StringEnum(["recent", "visible", "recent-unwrapped"] as const, {
					description: "Snapshot source to search (default 'recent').",
				}),
			),
			lines: Type.Optional(
				Type.Integer({
					description: "Restrict the searched snapshot to N lines.",
				}),
			),
			timeoutMs: Type.Optional(
				Type.Integer({ description: "Fail after this many ms (default 30000)." }),
			),
			raw: Type.Optional(
				Type.Boolean({
					description: "Keep ANSI escape sequences while matching (default false).",
				}),
			),
		}),
		async execute(_id, p, signal) {
			const pattern = p.match ?? p.regex;
			if (!pattern)
				return fail(
					err("VALIDATION_ERROR", "One of 'match' or 'regex' is required."),
				);
			if (p.match && p.regex)
				return fail(
					err(
						"VALIDATION_ERROR",
						"Provide only one of 'match' or 'regex', not both.",
					),
				);
			const timeoutMs = p.timeoutMs ?? 30_000;
			const r = await herdr<{ matched_line?: string; read?: unknown }>(
				waitOutputArgs(p.paneId, {
					match: p.match,
					regex: p.regex,
					source: p.source,
					lines: p.lines,
					timeoutMs,
					raw: p.raw,
				}),
				{ timeoutMs: timeoutMs + 8_000, signal },
			);
			if (!r.ok) return fail(r);
			const matchedLine = r.data?.matched_line ?? "";
			return okText(
				matchedLine
					? `Matched in pane ${p.paneId}: ${matchedLine}`
					: `Matched in pane ${p.paneId}.`,
				{ paneId: p.paneId, matchedLine, read: r.data?.read },
			);
		},
	});

	// 4. send_keys (destructive) ---------------------------------------------
	// `pane send-keys` / `agent send-keys` send LOGICAL key names only
	// (ctrl+c, esc, Enter). To type text use herdr_run_command (raw pane) or
	// herdr_send_prompt (agent). Labeled ⚠️ because ctrl+c interrupts a process.
	pi.registerTool({
		name: "herdr_send_keys",
		label: "Send keys to herdr pane",
		description:
			"⚠️ Destructive. Send logical key presses (e.g. 'ctrl+c', 'esc', 'Enter') to a pane. " +
			"By default targets the raw pane surface (paneId); set agentScope to target an agent by name/label. " +
			"Use herdr_run_command / herdr_send_prompt to type TEXT — this only sends key NAMES.",
		promptSnippet:
			"Send logical key presses (ctrl+c/esc/Enter) to a pane (destructive)",
		promptGuidelines: [
			"Use herdr_send_keys to interrupt (ctrl+c) or dismiss (esc) a pane; it sends key NAMES only — use herdr_run_command for text.",
		],
		parameters: Type.Object({
			target: Type.String({
				description: "Pane id (default) or, with agentScope, agent name/label.",
			}),
			keys: Type.Array(Type.String(), {
				description:
					"Logical key names to send, e.g. ['ctrl+c'], ['esc'], ['Enter'].",
			}),
			agentScope: Type.Optional(
				Type.Boolean({
					description:
						"Target the agent surface (agent send-keys, accepts name/label) instead of the raw pane (default false).",
				}),
			),
		}),
		async execute(_id, p, signal) {
			if (!p.keys?.length)
				return fail(
					err("VALIDATION_ERROR", "'keys' must be a non-empty array of key names."),
				);
			const scope = p.agentScope ? ["agent", "send-keys"] : ["pane", "send-keys"];
			const r = await herdr([...scope, p.target, ...p.keys], {
				timeoutMs: 10_000,
				signal,
			});
			if (!r.ok) return fail(r);
			return okText(
				`Sent keys ${JSON.stringify(p.keys)} to ${p.agentScope ? "agent" : "pane"} "${p.target}".`,
				{
					target: p.target,
					keys: p.keys,
					agentScope: Boolean(p.agentScope),
				},
			);
		},
	});
}
