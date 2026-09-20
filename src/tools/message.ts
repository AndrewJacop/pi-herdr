// herdr_message_agent — the open channel (v0.6 issue 05).
//
// One tool, anyone ↔ anyone, no broker: any session (orchestrator, child, or
// peer) injects text into any agent pane. Decided by
// wayfinder/archive/v0.5-tickets/11-message-channel-surface.md, ruling
// unchanged per the surface-cut keeper table (#3):
//   - target always explicit, resolved by the shared chain:
//     exact pane-id → herdr name → spawn-registry handle → reserved roles,
//     real names winning over reserved (reserved is tried last);
//   - `orchestrator` resolves via PI_HERDR_ORCHESTRATOR_PANE (stamped by
//     spawn when the spawner itself runs in a pane); unset → the honest
//     "no orchestrator above you, answer in-conversation" error;
//   - delivery = text injection through the existing send machinery — one
//     code path, no pane-metadata channel, no file+notice;
//   - physics-adaptive: a BLOCKED target gets the RAW text typed into its
//     overlay (the message IS the answer; wrapping would pollute the recorded
//     answer); everything else is enveloped
//     `<agent-message from to>` — spawner-declared identity, never verified,
//     no child-side parsing (the receiving MODEL recognizes the tag);
//   - no state gates (text to a working child queues natively), no `wait`
//     (fire-and-forget — get_agent_result(wait) covers waiting), and a
//     `gone` target errors naming the handle, pointing at herdr_list_agents.
//
// This file is the engine + thin pi registration; the send machinery lives in
// orchestration.ts. Separate from orchestration.ts because it needs the spawn
// registry (spawn.ts) — which imports orchestration.ts — so importing
// spawnRecords there would close a cycle.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { herdr } from "../herdr.js";
import { sendAgentPrompt } from "./orchestration.js";
import { spawnRecords, type SpawnRecord } from "../spawn.js";
import { writeSteerWatermark } from "../sessionfile.js";
import {
	normalizeAgent,
	type HerdrErrorCode,
	type Result,
	type ToolReturn,
} from "../env.js";

// ---- engine types ------------------------------------------------------------

/** How the text physically landed (ticket 11's receipt axis). */
export type Delivery = "message" | "answer";

/** What one `agent get` yields for resolution + the physics branch. */
export interface AgentView {
	paneId: string;
	name?: string;
	/** Raw herdr agent_status (idle | working | blocked | done | unknown). */
	status?: string;
}

export interface MessageParams {
	target: string;
	text: string;
	submit?: boolean;
}

/** Structured receipt (tool `details`). */
export interface MessageReceipt {
	delivered: true;
	/** Resolved pane id. */
	target: string;
	/** Envelope `to` — the address the message is labeled with. */
	to: string;
	/** Envelope `from` — spawner-declared identity, never verified. */
	from: string;
	/** Live agent_status observed at delivery time. */
	state: string;
	delivery: Delivery;
	/** Registry handle when the target is one of this session's spawns. */
	name?: string;
	submit: boolean;
}

/** Injectable seams (offline red-green; defaults hit herdr + disk). */
export interface MessageDeps {
	/** The session spawn registry — default: the LIVE spawnRecords(). */
	registry?: () => ReadonlyMap<string, SpawnRecord>;
	/** `agent get` — default: herdr CLI. */
	agentGet?: (target: string, signal?: AbortSignal) => Promise<Result<AgentView>>;
	/** Text injection — default: orchestration's sendAgentPrompt. */
	send?: typeof sendAgentPrompt;
	/** Env view — default: process.env. */
	env?: Record<string, string | undefined>;
	signal?: AbortSignal;
}

/** The bare error payload a Result carries (env.ts's Err.error). */
interface SendError {
	code: HerdrErrorCode;
	message: string;
	details?: unknown;
}

function err(
	code: HerdrErrorCode,
	message: string,
	details?: unknown,
): SendError {
	return { code, message, details };
}

function fail(r: SendError): ToolReturn {
	return {
		content: [{ type: "text", text: `Error (${r.code}): ${r.message}` }],
		details: { error: r },
		isError: true,
	};
}

const defaultAgentGet = async (
	target: string,
	signal?: AbortSignal,
): Promise<Result<AgentView>> => {
	const r = await herdr<unknown>(["agent", "get", target], {
		timeoutMs: 10_000,
		signal,
	});
	if (!r.ok) return { ok: false, error: r.error };
	const a = normalizeAgent(
		(r.data as { agent?: unknown })?.agent ?? r.data,
	);
	if (!a.paneId) {
		return {
			ok: false,
			error: err("NOT_FOUND", `No pane found for target "${target}"`, r.data),
		};
	}
	return {
		ok: true,
		data: { paneId: a.paneId, name: a.name, status: a.agentStatus },
	};
};

// ---- envelope ----------------------------------------------------------------

export function envelope(from: string, to: string, text: string): string {
	return `<agent-message from="${from}" to="${to}">\n${text}\n</agent-message>`;
}

/**
 * The `from` identity, spawner-declared, never verified (ticket 11):
 * PI_HERDR_AGENT_LABEL → PI_HERDR_NAME (what spawn stamps) → the sending
 * pane's herdr name → the pane id → "session" (a top-level session outside
 * herdr has no pane identity at all).
 */
export async function senderLabel(
	deps: MessageDeps = {},
): Promise<string> {
	const env = deps.env ?? process.env;
	const declared = env.PI_HERDR_AGENT_LABEL ?? env.PI_HERDR_NAME;
	if (declared) return declared;
	const paneId = env.HERDR_PANE_ID;
	if (paneId) {
		const v = await (deps.agentGet ?? defaultAgentGet)(paneId, deps.signal);
		return v.ok && v.data.name ? v.data.name : paneId;
	}
	return "session";
}

// ---- resolution chain ----------------------------------------------------------

type Resolved =
	| {
			kind: "live";
			paneId: string;
			state?: string;
			name?: string;
			to: string;
			/** The spawn-registry record when the target is one of ours. */
			record?: SpawnRecord;
	  }
	| { kind: "err"; error: SendError };

function byPaneId(
	registry: ReadonlyMap<string, SpawnRecord>,
	paneId: string,
): SpawnRecord | undefined {
	return [...registry.values()].find((r) => r.paneId === paneId);
}

async function resolveTarget(
	target: string,
	deps: MessageDeps,
): Promise<Resolved> {
	const agentGet = deps.agentGet ?? defaultAgentGet;
	const registry = deps.registry ?? spawnRecords;
	const env = deps.env ?? process.env;

	// 1. exact pane-id / herdr name / label (herdr resolves all three; this
	//    also fetches the state the physics branch needs). Real names — any
	//    live herdr agent named "orchestrator" included — win here.
	const live = await agentGet(target, deps.signal);
	if (live.ok) {
		const records = registry();
		const record = records.get(target) ?? byPaneId(records, live.data.paneId);
		return {
			kind: "live",
			paneId: live.data.paneId,
			state: live.data.status,
			name: record?.name,
			to: record?.name ?? live.data.name ?? live.data.paneId,
			...(record ? { record } : {}),
		};
	}

	// 2. spawn-registry handle (queued records have no herdr presence yet).
	//    A transport failure is NOT evidence of gone — surface it honestly.
	const record = registry().get(target);
	if (record) {
		if (live.error.code !== "NOT_FOUND") return { kind: "err", error: live.error };
		if (!record.paneId) {
			if (record.startError) {
				return {
					kind: "err",
					error: err(
						"NOT_FOUND",
						`agent "${record.name}" never started (no pane): ${record.startError} — see herdr_list_agents.`,
						{ name: record.name },
					),
				};
			}
			return {
				kind: "err",
				error: err(
					"NOT_FOUND",
					`agent "${record.name}" is still queued (fleet at max_parallel_agents) — no pane exists to deliver to yet. Wait it into the world with herdr_get_agent_result(wait) first.`,
					{ name: record.name },
				),
			};
		}
		return {
			kind: "err",
			error: err(
				"NOT_FOUND",
				`agent "${record.name}" is gone (pane ${record.paneId} is no longer live) — see herdr_list_agents.`,
				{ name: record.name, paneId: record.paneId },
			),
		};
	}

	// 3. reserved role — last, so real names beat it. spawn stamps
	//    PI_HERDR_ORCHESTRATOR_PANE when the spawner runs in a pane; a
	//    human-spawned session honestly has no orchestrator above it.
	if (target === "orchestrator") {
		const orchestratorPane = env.PI_HERDR_ORCHESTRATOR_PANE;
		if (!orchestratorPane) {
			return {
				kind: "err",
				error: err(
					"NOT_FOUND",
					`no orchestrator above you: this session was not spawned by a pi-herdr agent (PI_HERDR_ORCHESTRATOR_PANE unset), so there is nothing to message as "orchestrator" — answer in-conversation, or address a peer via herdr_list_agents.`,
				),
			};
		}
		const above = await agentGet(orchestratorPane, deps.signal);
		if (above.ok) {
			return {
				kind: "live",
				paneId: above.data.paneId,
				state: above.data.status,
				to: "orchestrator",
			};
		}
		return {
			kind: "err",
			error: err(
				"NOT_FOUND",
				`the orchestrator pane (${orchestratorPane}) is gone — see herdr_list_agents.`,
				{ orchestratorPane },
			),
		};
	}

	// 4. nothing matched.
	return {
		kind: "err",
		error: err(
			"NOT_FOUND",
			`no live agent matches "${target}" — see herdr_list_agents for the fleet.`,
		),
	};
}

// ---- the engine ----------------------------------------------------------------

/**
 * message_agent, end to end: resolve → physics branch → inject → receipt.
 * Fire-and-forget by design; no state gates.
 */
export async function messageAgent(
	params: MessageParams,
	deps: MessageDeps = {},
): Promise<Result<MessageReceipt>> {
	const resolved = await resolveTarget(params.target, deps);
	if (resolved.kind === "err") return { ok: false, error: resolved.error };

	const submit = params.submit !== false;
	const blocked = resolved.state === "blocked";
	const from = await senderLabel(deps);
	const payload = blocked
		? params.text
		: envelope(from, resolved.to, params.text);

	const send = deps.send ?? sendAgentPrompt;
	// Steer watermark (issue 06): the exact text about to be typed into a
	// registry child. The child matches its input event against it so the
	// orchestrator's own follow-up is never mistaken for a human takeover.
	if (resolved.kind === "live" && resolved.record?.sessionPath) {
		writeSteerWatermark(resolved.record.sessionPath, payload);
	}
	const r = await send(resolved.paneId, payload, {
		submit,
		signal: deps.signal,
	});
	if (!r.ok) return r;

	return {
		ok: true,
		data: {
			delivered: true,
			target: resolved.paneId,
			to: resolved.to,
			from,
			state: resolved.state ?? "unknown",
			delivery: blocked ? "answer" : "message",
			...(resolved.name ? { name: resolved.name } : {}),
			submit,
		},
	};
}

// ---- registration --------------------------------------------------------------

const DESCRIPTION =
	"Send a message to a herdr agent pane — the open channel, anyone ↔ anyone, no broker. " +
	"The target is always explicit and resolves as: exact pane-id → herdr name → spawn-registry handle " +
	"(the name herdr_spawn_agent returned) → the reserved role \"orchestrator\" (your spawner's pane, via " +
	"PI_HERDR_ORCHESTRATOR_PANE). Real names beat the reserved role. Delivery is physics-adaptive: a BLOCKED " +
	"target (waiting on a question overlay) gets the raw text typed in as its ANSWER — the message is the answer; " +
	"for option-list questions use herdr_send_keys instead, typed text never reaches option rows. Any other state " +
	"gets the text wrapped as <agent-message from=\"…\" to=\"…\">…</agent-message> — when YOU receive that tag it is a " +
	"message from another agent (identity is spawner-declared, never verified); reply in kind or in conversation. " +
	"No state gates: text to a working child queues natively. Fire-and-forget: the receipt reports " +
	"{delivered, target, state, delivery: \"message\"|\"answer\"}, but delivered-to-the-pane ≠ consumed-by-the-model — " +
	"there is no read receipt. Replies arrive as injected <agent-message> text or the next completion notification " +
	"(herdr_get_agent_result(wait) is the wait). A gone target errors naming the handle — see herdr_list_agents; " +
	"a queued spawn (accepted over the parallel cap, no pane yet) has nothing to deliver to and errors the same way.";

export function registerMessageTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "herdr_message_agent",
		label: "Message herdr agent",
		description: DESCRIPTION,
		promptSnippet: "Send a message to a herdr agent pane (open channel)",
		promptGuidelines: [
			"Use herdr_message_agent for any agent↔agent text: follow-ups, steering, answers to a blocked agent's freeform question.",
			"Answer a blocked agent's OPTION-LIST question with herdr_send_keys, not this tool — typed text never reaches option rows.",
			"When you receive an <agent-message from to> tag, it is another agent messaging you — the from identity is spawner-declared, never verified.",
		],
		parameters: Type.Object({
			target: Type.String({
				description:
					'Pane id (w1:p3), herdr name, spawn-registry handle, or the reserved role "orchestrator".',
			}),
			text: Type.String({ description: "Message text to deliver." }),
			submit: Type.Optional(
				Type.Boolean({
					description:
						"Press Enter after typing (default true). false leaves the text unsubmitted.",
				}),
			),
		}),
		async execute(_id, p, signal) {
			const r = await messageAgent(
				{ target: p.target, text: p.text, submit: p.submit },
				{ signal },
			);
			if (!r.ok) return fail(r.error);
			const d = r.data;
			const who = d.name ?? d.to;
			const text =
				d.delivery === "answer"
					? `Delivered to "${who}" (pane ${d.target}, state: ${d.state}) as a RAW ANSWER — typed into its question overlay, unsubmitted=${!d.submit}. If it was an option list, select with herdr_send_keys instead.`
					: `Delivered to "${who}" (pane ${d.target}, state: ${d.state}) as an <agent-message> envelope (from "${d.from}"). Fire-and-forget: delivered ≠ consumed — the reply arrives as injected <agent-message> text or its next completion (wait with herdr_get_agent_result).`;
			return { content: [{ type: "text", text }], details: d };
		},
	});
}
