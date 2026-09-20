// herdr_get_agent_result — the pull/inspection tool (v0.6 issue 04).
//
// For pi children this session spawned, the result source is the child's
// parent-owned session JSONL: the EXACT last assistant message — no screen
// scraping, no tail heuristics, no truncation ambiguity. The completion
// sidecar (`<session>.exit`, written by the injected child extension) is
// checked BEFORE pane status: an auto-exited autonomous child is already
// gone from the fleet when its typed sidecar lands, and `gone` must not
// swallow a finished result.
//
// The pane-tail reader (`agent read`) survives ONLY as fallback for panes
// without a session substrate — panes this session didn't spawn (adopted)
// and non-pi passthrough kinds (ticket 01 ruling; research §2). For spawned
// pi children it is never consulted.
//
// Statuses are COARSE interim vocabulary until ticket 07 lands the ten-state
// projection: queued | working | idle | done | blocked | error | gone.
// `gone` is a valid terminal answer carrying last-known registry metadata;
// sessions are never deleted by pi-herdr, so a gone pane's session file (and
// its result) remains readable — only the live pane is lost.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	extractText,
	type Err,
	type HerdrErrorCode,
	type Result,
	type ToolReturn,
} from "../env.js";
import { herdr } from "../herdr.js";
import { getAgentStatus } from "./orchestration.js";
import {
	extractSessionResult,
	minedAssistantError,
	readExitSidecar,
	type ExtractedResult,
	type ReadSidecarResult,
} from "../sessionfile.js";
import { spawnRecords, type SpawnRecord } from "../spawn.js";

// ---- engine types -------------------------------------------------------------

/** The coarse result-tool status (07 projects these into the ten-state set). */
export type ResultStatus =
	| "queued"
	| "working"
	| "idle"
	| "done"
	| "blocked"
	| "error"
	| "gone";

/** Structured inspection payload (tool `details`). */
export interface ResultView {
	target: string;
	/** Registry handle when the target is one of ours. */
	name?: string;
	kind?: string;
	type?: string;
	stance?: string;
	status: ResultStatus;
	/** Exact final assistant message text (pi children; source session-jsonl). */
	result?: string;
	/** The full last assistant message object, verbatim from the session JSONL. */
	message?: unknown;
	/** True when the child is still running — this is a mid-flight snapshot. */
	interim?: boolean;
	/** Where the result text came from. */
	source: "session-jsonl" | "pane-tail" | "registry";
	/** Parent-owned session file + completion sidecar (pi children). */
	sessionPath?: string;
	exitPath?: string;
	/** Typed child failure (sidecar or mined off the last assistant message). */
	error?: { stopReason?: string; errorMessage: string };
	/** Pane-tail read metadata (fallback path only). */
	tail?: { truncated?: boolean };
	/** Last-known registry metadata for a pane that vanished (valid terminal). */
	lastKnown?: Record<string, unknown>;
	/** True when the target was never spawned by this session (adopted pane). */
	adopted?: boolean;
	note?: string;
}

export interface GetResultParams {
	target: string;
	wait?: boolean | number;
	lines?: number;
}

/** Injectable seams (offline red-green; defaults hit herdr + disk). */
export interface GetResultDeps {
	/** The session spawn registry — default: the LIVE spawnRecords(). */
	registry?: () => ReadonlyMap<string, SpawnRecord>;
	/** Live agent_status — default: getAgentStatus. */
	status?: (paneId: string) => Promise<Result<string>>;
	/** Pane-tail read (fallback) — default: `herdr agent read`. */
	readTail?: (
		target: string,
		lines: number,
	) => Promise<Result<{ text: string; truncated?: boolean }>>;
	/** Session-JSONL extraction — default: extractSessionResult. */
	extract?: (sessionPath: string) => ExtractedResult | null;
	/** Completion-sidecar read — default: readExitSidecar. */
	readSidecar?: (sessionPath: string) => ReadSidecarResult;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
	pollMs?: number;
	signal?: AbortSignal;
}

const TERMINAL: ReadonlySet<ResultStatus> = new Set([
	"done",
	"error",
	"blocked",
	"gone",
]);

const sleep = (ms: number): Promise<void> =>
	new Promise((r) => setTimeout(r, ms));

/** Build a non-ok Result with a normalized error code. */
function err(code: HerdrErrorCode, message: string, details?: unknown): Err {
	return { ok: false, error: { code, message, details } };
}

/** Last-known registry metadata, for `gone` answers. */
function lastKnownOf(record: SpawnRecord): Record<string, unknown> {
	return {
		name: record.name,
		kind: record.kind,
		type: record.type,
		stance: record.stance,
		depth: record.depth,
		spawnedAt: record.spawnedAt,
		startedAt: record.startedAt,
		lastStatus: record.lastStatus,
		startError: record.startError,
		worktreePath: record.worktreePath,
		...(record.sessionPath ? { sessionPath: record.sessionPath } : {}),
		...(record.activityPath ? { activityPath: record.activityPath } : {}),
	};
}

/** Common envelope fields for a registry target (status filled per path). */
function viewBase(
	target: string,
	record: SpawnRecord,
): Omit<ResultView, "status"> {
	return {
		target,
		name: record.name,
		kind: record.kind,
		type: record.type,
		stance: record.stance,
		source: "registry",
		...(record.sessionPath
			? {
					sessionPath: record.sessionPath,
					exitPath: `${record.sessionPath}.exit`,
				}
			: {}),
	};
}

/**
 * One inspection pass over a registry record: sidecar first (a finished
 * auto-exited child is `gone` in the fleet but `done`/`error` here), then
 * live pane status, then the session JSONL for interim/final pi results.
 */
async function inspectRecord(
	target: string,
	record: SpawnRecord,
	deps: GetResultDeps,
	lines: number,
): Promise<ResultView> {
	const base = viewBase(target, record);
	const isPi = record.kind.toLowerCase() === "pi" && Boolean(record.sessionPath);
	const extract = deps.extract ?? extractSessionResult;
	const readSidecar = deps.readSidecar ?? readExitSidecar;

	// 1. typed sidecar — the child's own terminal declaration.
	if (isPi && record.sessionPath) {
		const sidecar = readSidecar(record.sessionPath);
		if (sidecar.state === "ok") {
			const extracted = extract(record.sessionPath);
			if (sidecar.sidecar.type === "done") {
				return {
					...base,
					status: "done",
					source: "session-jsonl",
					...(extracted
						? { result: extracted.text, message: extracted.message }
						: {
								note:
									"sidecar is done but the session file holds no assistant message yet",
							}),
				};
			}
			return {
				...base,
				status: "error",
				source: "session-jsonl",
				error: {
					...(sidecar.sidecar.stopReason
						? { stopReason: sidecar.sidecar.stopReason }
						: {}),
					errorMessage: sidecar.sidecar.errorMessage,
				},
				...(extracted ? { message: extracted.message } : {}),
			};
		}
		// invalid/missing: not evidence — fall through to live status.
	}

	// 2. no pane ever started.
	if (record.startError) {
		return {
			...base,
			status: "gone",
			lastKnown: lastKnownOf(record),
			note: `the pane never started: ${record.startError}`,
		};
	}
	if (!record.paneId) return { ...base, status: "queued" };

	// 3. live pane status (coarse authority until 07's projection).
	const statusOf = deps.status ?? getAgentStatus;
	const live = await statusOf(record.paneId);
	if (!live.ok) {
		const code = live.error.code;
		const inner = (live.error.details as { code?: string } | undefined)?.code;
		if (code === "NOT_FOUND" || inner === "agent_not_found") {
			// The pane vanished. Race the sidecar once more (auto-exit writes it
			// just before shutdown): a done/error sidecar still wins over gone.
			if (isPi && record.sessionPath) {
				const sidecar = readSidecar(record.sessionPath);
				if (sidecar.state === "ok" && sidecar.sidecar.type === "done") {
					const extracted = extract(record.sessionPath);
					return {
						...base,
						status: "done",
						source: "session-jsonl",
						...(extracted
							? { result: extracted.text, message: extracted.message }
							: {}),
					};
				}
				if (sidecar.state === "ok" && sidecar.sidecar.type === "error") {
					return {
						...base,
						status: "error",
						source: "session-jsonl",
						error: {
							...(sidecar.sidecar.stopReason
								? { stopReason: sidecar.sidecar.stopReason }
								: {}),
							errorMessage: sidecar.sidecar.errorMessage,
						},
					};
				}
			}
			return {
				...base,
				status: "gone",
				lastKnown: lastKnownOf(record),
				...(isPi && record.sessionPath
					? (() => {
							// The pane died without a sidecar. If its last word was a
							// failed attempt, that failure IS the terminal answer —
							// more informative than a bare gone.
							const extracted = extract(record.sessionPath);
							const mined = extracted && minedAssistantError(extracted.message);
							if (mined && extracted) {
								return {
									status: "error" as const,
									source: "session-jsonl" as const,
									message: extracted.message,
									error: {
										stopReason: mined.stopReason,
										errorMessage: mined.errorMessage,
									},
									note: "pane died after a failed attempt; no sidecar was written",
								};
							}
							return {
								note: "pane is gone; its session file remains readable (pi --session) — no completion sidecar was written",
							};
						})()
					: {}),
			};
		}
		// transient herdr error — keep the last-known-live view
		return {
			...base,
			status: "working",
			interim: true,
			note: `pane status unavailable (${live.error.message})`,
		};
	}
	record.lastStatus = live.data;

	// blocked: an ask-user overlay — not a result; steering is the answer.
	if (live.data === "blocked") return { ...base, status: "blocked" };

	if (live.data === "idle" || live.data === "done") {
		const settled = record.submitted || record.sawWorking;
		if (!settled) return { ...base, status: "idle" };
		// settled with an unconsumed result — pi children: read the JSONL.
		if (isPi && record.sessionPath) {
			const extracted = extract(record.sessionPath);
			if (extracted) {
				const mined = minedAssistantError(extracted.message);
				if (mined && record.stance === "autonomous") {
					// A failed attempt on a LIVE autonomous pane is not yet
					// exhaustion: the child's grace window lets pi retry. Keep
					// polling (working); the typed payload rides along so callers
					// see the truth.
					return {
						...base,
						status: "working",
						interim: true,
						source: "session-jsonl",
						message: extracted.message,
						result: extracted.text,
						error: { stopReason: mined.stopReason, errorMessage: mined.errorMessage },
						note: "last attempt failed; the child may still retry — wait for the sidecar or pane exit",
					};
				}
				if (mined) {
					// Interactive children never write a sidecar and never
					// auto-exit: a settled error is final for them.
					return {
						...base,
						status: "error",
						source: "session-jsonl",
						message: extracted.message,
						error: { stopReason: mined.stopReason, errorMessage: mined.errorMessage },
					};
				}
				return {
					...base,
					status: "done",
					source: "session-jsonl",
					result: extracted.text,
					message: extracted.message,
				};
			}
			return {
				...base,
				status: "done",
				source: "session-jsonl",
				note: "no assistant message in the session file yet",
			};
		}
		// Non-pi children have no session substrate — the pane-tail fallback is
		// the only result source for them (ticket 01 §5).
		return inspectAdopted(target, deps, lines, base);
	}

	// working/unknown: mid-flight snapshot — pi children get the message-so-far.
	const view: ResultView = { ...base, status: "working", interim: true };
	if (isPi && record.sessionPath) {
		const extracted = extract(record.sessionPath);
		if (extracted) {
			view.source = "session-jsonl";
			view.result = extracted.text;
			view.message = extracted.message;
			view.note = "mid-flight snapshot — the child is still running";
		}
	}
	return view;
}

/**
 * get_agent_result, end to end. Single-shot unless `wait` is set: true =
 * until terminal (done/error/blocked/gone — waiting through the queue), a
 * number = bounded, current state on expiry.
 */
export async function getAgentResult(
	params: GetResultParams,
	deps: GetResultDeps = {},
): Promise<Result<ResultView>> {
	const now = deps.now ?? (() => Date.now());
	const pollMs = deps.pollMs ?? 1_500;
	const wait = params.wait;
	let deadline: number;
	if (wait === true) deadline = Infinity;
	else if (typeof wait === "number") deadline = now() + wait;
	else deadline = now();

	for (;;) {
		if (deps.signal?.aborted) return err("TIMEOUT", "aborted");
		const lines = params.lines ?? 80;
		const record = (deps.registry ?? spawnRecords)().get(params.target);
		if (!record) {
			// paneId match — a handle is the addressable key, but callers may
			// pass the pane id they got back from spawn.
			const byPane = [...(deps.registry ?? spawnRecords)().values()].find(
				(r) => r.paneId && r.paneId === params.target,
			);
			if (byPane)
				return {
					ok: true,
					data: await inspectRecord(byPane.name, byPane, deps, lines),
				};
			return { ok: true, data: await inspectAdopted(params.target, deps, lines) };
		}
		const view = await inspectRecord(params.target, record, deps, lines);
		if (TERMINAL.has(view.status) || now() >= deadline)
			return { ok: true, data: view };
		await (deps.sleep ?? sleep)(pollMs);
	}
}

/**
 * The fallback: a pane this session did not spawn (adopted) — or any target
 * the registry does not know, or a spawned NON-pi kind (no session substrate).
 * Pane-tail reading only; never used for spawned pi children.
 */
async function inspectAdopted(
	target: string,
	deps: GetResultDeps,
	lines = 80,
	base?: Omit<ResultView, "status">,
): Promise<ResultView> {
	const readTail =
		deps.readTail ??
		(async (t: string, n: number) => {
			const r = await herdr<unknown>(
				[
					"agent",
					"read",
					t,
					"--source",
					"recent",
					"--lines",
					String(n),
					"--format",
					"text",
				],
				{ timeoutMs: 15_000, signal: deps.signal, textOk: true },
			);
			if (!r.ok) return r;
			return {
				ok: true as const,
				data: {
					text: extractText(r.data),
					truncated: Boolean((r.data as { truncated?: boolean })?.truncated),
				},
			};
		});
	const r = await readTail(target, lines);
	if (!r.ok)
		return {
			...(base ?? { target, source: "registry" as const }),
			status: "gone",
			adopted: !base,
		};
	return {
		...(base ?? { target, source: "registry" as const }),
		status: "working",
		source: "pane-tail",
		adopted: !base,
		result: r.data.text,
		tail: { truncated: r.data.truncated },
		note: base
			? "pane-tail fallback: this non-pi child has no session file to read exactly"
			: "pane-tail fallback: this pane was not spawned by pi-herdr, so there is no session file to read exactly",
	};
}

// ---- registration -------------------------------------------------------------

function fail(r: Err): ToolReturn {
	return {
		content: [
			{ type: "text", text: `Error (${r.error.code}): ${r.error.message}` },
		],
		details: { error: r.error },
		isError: true,
	};
}

/** Render a ResultView as the tool's text + error flag. */
function render(view: ResultView): ToolReturn {
	const label = view.name ?? view.target;
	const where = view.sessionPath ? ` (session: ${view.sessionPath})` : "";
	switch (view.status) {
		case "done":
			return {
				content: [
					{
						type: "text",
						text: view.result
							? `Agent "${label}" finished — exact final message:\n\n${view.result}`
							: `Agent "${label}" finished, but no assistant message was found in its session file.${where}`,
					},
				],
				details: view,
			};
		case "error": {
			const msg = view.error?.errorMessage ?? "child failed";
			return {
				content: [
					{
						type: "text",
						text: `Agent "${label}" FAILED: ${msg}${where}`,
					},
				],
				details: view,
				isError: true,
			};
		}
		case "queued":
			return {
				content: [
					{
						type: "text",
						text: `Agent "${label}" is still queued (fleet at max_parallel_agents) — no pane yet.`,
					},
				],
				details: view,
			};
		case "working":
			return {
				content: [
					{
						type: "text",
						text: view.result
							? `Agent "${label}" is still working — interim snapshot of its latest message so far:\n\n${view.result}`
							: `Agent "${label}" is still working — no assistant message yet.`,
					},
				],
				details: view,
			};
		case "blocked":
			return {
				content: [
					{
						type: "text",
						text: `Agent "${label}" is BLOCKED on a question. Answer freeform with herdr_message_agent (the raw text becomes its answer); option lists take herdr_send_keys — see herdr_list_agents.`,
					},
				],
				details: view,
			};
		case "idle":
			return {
				content: [
					{
						type: "text",
						text: `Agent "${label}" is idle (prompt not yet submitted).`,
					},
				],
				details: view,
			};
		case "gone":
		default: {
			const known = view.lastKnown
				? ` Last-known: ${Object.entries(view.lastKnown)
						.filter(([, v]) => v !== undefined)
						.map(([k, v]) => `${k}=${String(v)}`)
						.join(", ")}.`
				: "";
			const resume = view.sessionPath
				? ` Its session file is retained (${view.sessionPath}) — readable and resumable; nothing was lost.`
				: "";
			return {
				content: [
					{
						type: "text",
						text: `Agent "${label}" is gone (no live pane).${resume}${known}${view.note ? ` ${view.note}` : ""}`,
					},
				],
				details: view,
			};
		}
	}
}

export function registerResultTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "herdr_get_agent_result",
		label: "Get herdr agent result",
		description:
			"Pull an agent's result — the inspection tool for agents you spawned with herdr_spawn_agent. " +
			"For pi children it reads the exact final assistant message from the agent's session file " +
			"(byte-identical, complete — no screen scraping); mid-flight calls return an interim snapshot. " +
			"For panes this session did not spawn (or non-pi kinds) it falls back to pane-tail reading. " +
			"A gone pane still answers with its last-known metadata; its session file stays readable and resumable. " +
			"`wait: true` blocks until done/failed/blocked/gone (through the queue); `wait: <ms>` returns the current state on expiry.",
		promptSnippet: "Pull an agent's result (exact final message for pi children)",
		promptGuidelines: [
			"Use herdr_get_agent_result to fetch a spawned agent's result — it returns the exact final assistant message, not a screen scrape.",
			"A 'gone' result still carries last-known metadata and the retained session path; sessions are never deleted.",
		],
		parameters: Type.Object({
			target: Type.String({
				description:
					"Spawn handle (the name herdr_spawn_agent returned) or pane id.",
			}),
			wait: Type.Optional(
				Type.Union([Type.Boolean(), Type.Integer()], {
					description:
						"true = block until done/failed/blocked/gone; ms = current state on expiry; omit = single-shot snapshot.",
				}),
			),
			lines: Type.Optional(
				Type.Integer({
					description:
						"Pane-tail line budget for the non-spawned fallback (default 80).",
				}),
			),
		}),
		async execute(_id, p, signal) {
			const r = await getAgentResult(
				{ target: p.target, wait: p.wait, lines: p.lines },
				{ signal },
			);
			if (!r.ok) return fail(r);
			return render(r.data);
		},
	});
}
