---
label: wayfinder:grilling
status: closed
assignee: Andrew
blocked-by: [01-substrate]
---

## Question

How results travel from children to the orchestrator: push vs pull, what the user's intervention in a child pane does to the contract, and what happens to abandoned takeovers (the headless case). Supersedes v0.5-04 (`archive/v0.5-tickets/04-completion-notifications.md`) — the `<task-notification>` doorbell design is dead.

## Resolution

All decisions HITL-grilled 2026-09-19 at the v0.6 re-spec. Core ruling: **hybrid, but automatic — not a knob.** There is no `delivery: push|pull` parameter. Delivery is determined by the measured situation of the run.

1. **Push on completion (the default path).** When a child finishes, the **full final assistant message** is steered into the orchestrator session; `notifications: normal` (setting) wakes it (`triggerTurn`), `quiet` delivers on its next natural turn, **blocked always wakes**. The push replaces the doorbell: no summary-then-fetch, no `<task-notification>` XML. Completion is detected via the substrate's sidecars (`done`/`error` typed), with the terminal sentinel and pane-disappearance grace as fallbacks (triply redundant, adopted from prior art §3).
2. **Two completion routes, both pushing normally.** **Auto-settle** — autonomous child finishes (`agent_settled`), auto-exit writes the sidecar, pane closes. **Declared** — the child calls its injected `agent_done` tool. `caller_ping`-style help requests ride `message_agent` (v0.5-11 ruling unchanged) — no separate exit-based ping tool.
3. **Pull always available.** `get_agent_result` survives as the *inspection* tool: mid-flight snapshot, bounded waits (`wait?: ms | true`), early fetch, re-read of missed results. It is no longer the mandatory second step after spawn.
4. **User takeover — the core split.** Prior art fuses pane-closing and the result contract under takeover (any keystroke kills both permanently). We split them:
   - **Auto-exit (pane closing): disabled by takeover.** A pane never slams shut while a human reads or types in it. The one permanent-ish effect — subject to idle re-arm below.
   - **Result contract: never revoked.** `agent_done` stays available to the child regardless of takeover; the session file is readable before, during, and after any intervention. Nothing is ever impossible to pull back.
5. **Idle re-arm — the headless plug.** After a takeover, if the child settles and receives no further input for **N minutes (default 15, setting `idle_rearm_minutes`)**: the latest final assistant message is pushed to the orchestrator, honestly labeled *auto-delivered after user steer*; the pane closes; the session file is retained for resume. Timer starts on `agent_settled` (never mid-work), any keystroke resets it. SSH-in → steer → log out → result arrives, no orphan panes.
6. **Takeover notice.** The orchestrator gets a **quiet** (no-wake) note — `user took over <agent>` — on its next natural turn; takeover is also a widget state and an honest `get_agent_result` answer.
7. **No mid-conversation pushes from taken-over panes.** Only a final result (declared or re-armed) ever lands in orchestrator context.

**Feeds:** `03` (statuses consume delivery events), `07` (rows leave on delivery), `08` (workflow `agent()` awaits the same push path).
