---
label: wayfinder:grilling
status: closed
assignee: Andrew Jacop
blocked-by: []
---

## Question

How do background agent completions become notifications? Design the watcher (poll herdr agent status — existing footer logic is the seed; what interval, what dedup), the completion-event → `pi.sendMessage` nextTurn delivery, and the notification content/format (themed box, result preview via `agent read`, duration, status — blocked/failed states made loud; no token/cost claims). The verbosity knob is settled in ticket `03`: `notifications: "none" | "quiet" | "normal"` (default `"normal"`), read-at-use — decide here what exactly `quiet` suppresses vs `normal`, with `blocked` always loud at any level above `none` (charter item 6). Also include: behavior when the orchestrator session is mid-turn, notification for *blocked* agents (not just completion), and how the model consumes a result it missed (`get_agent_result` interplay). Zoom tintinweb's `index.ts` notification path and ticket `09`'s findings when ready.

## Resolution

HITL-grilled 2025-12 (wayfinder work-through session). Anchors zoomed: `src/index.ts` footer logic, `src/tools/orchestration.ts` `waitForStatus`/`transitionWaitArgs`, pi docs `sendMessage` (`deliverAs`/`triggerTurn`), tintinweb `index.ts` (scheduleNudge / `formatTaskNotification` / GroupJoinManager), ticket `09`'s borrow list.

1. **Watch scope: session-spawned only.** The extension's spawn registry (name → paneId, from `spawn_agent`) is the watch list; no fleet-wide notifications. Two orchestrator sessions never double-notify, hand-spawned panes stay the human's business — the footer/widget keep whole-fleet awareness.
2. **Watcher: one poll loop, 5s, while any spawned agent is live.** Single timer → `herdr agent list` (one CLI exec per tick), diffed against a per-agent last-seen-state map. Zero cost when not orchestrating (timer stops when the registry empties). Transition fires only after re-verifying with `agent get` (verify-before-act, ticket 09 pattern) — kills boot-blip false completions. Registry records spawn time (duration source, all kinds — honest fidelity).
3. **Delivery: `normal` wakes, `quiet` doesn't; `blocked` always wakes.** `normal` = `pi.sendMessage(..., {deliverAs: "followUp", triggerTurn: true})` — idle orchestrator immediately consumes the result. `quiet` = `{deliverAs: "nextTurn"}` — identical message, recorded for the next user prompt, no wake. `blocked` uses the `normal` path at both levels. `none` sends nothing. The verbosity axis is exactly wake-vs-no-wake; content is identical at `quiet` and `normal`. (Refines the charter's "nextTurn delivery" wording — followUp+triggerTurn is what makes `normal` useful.)
4. **Content: `<task-notification>` XML, honest fields only.** tintinweb's convention (Claude Code lineage): `<handle>`, `<kind>`, `<status>`, `<duration_ms>`, `<result>` (≤500-char preview via `agent read`, truncation marker pointing at `get_agent_result`), `<question>` for blocked (so the orchestrator can relay without re-reading). No tokens/cost/tool_uses (charter 6/8 — external CLIs don't report them). Statuses: `done`, `blocked`, `gone` (pane vanished — killed/crashed/closed = terminal, model must know). Human-facing: themed box via `registerMessageRenderer` on the `customType`, fed by structured `details` (charter item 6).
5. **Mid-turn: `followUp` uniformly.** Queued while the orchestrator streams, delivered at turn end, then wake. Blocked does NOT `steer`/cut in line — loudness comes from wake + `<question>`, one delivery path for every case.
6. **Edge defaults (all confirmed):** no group-join/batching — one message per agent, N completions = N sequential followUps; no replay across restart — `session_start` re-baselines the fleet snapshot, no retro-notifications (`get_agent_result` recovers anything missed; nicobailon's durable-file queue explicitly avoided — panes are the durability); `resultConsumed` suppression — if `get_agent_result` already pulled a handle's result before the nudge fires, the completion nudge is suppressed (flag checked at send time; the 5s poll granularity covers tintinweb's 200ms-hold race). Blocked notifications are never suppressed.

**Consumed by:** ticket `10` (`get_agent_result` must set the `resultConsumed` flag on the shared registry — contract, params stay ticket 10's to decide), ticket `05` (the widget reads the same spawn registry + last-seen map).
