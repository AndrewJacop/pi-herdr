# `herdr_message_agent`

**The open channel** (v0.6 issue 05) — one tool, anyone ↔ anyone, no broker:
any session (orchestrator, child, or peer) delivers text to any agent pane.
Absorbed `herdr_send_prompt` (same send machinery underneath; the deleted tool
was the last of the legacy result trio).

**Wraps:** `agent prompt <target> <text>` (submit) or `pane send-text <pane>
<text>` (`submit: false`) — the same delivery path the spawn engine uses for
task prompts.

## Params

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `target` | string | yes | Always explicit: pane id → herdr name → spawn-registry handle → reserved `orchestrator` role. Real names win over the reserved role. |
| `text` | string | yes | Message text to deliver. |
| `submit` | boolean | no | Press Enter after typing (default `true`). `false` creates no task and cannot set `notify`. |
| `notify` | `"wake" \| "quiet" \| "none"` | no | Completion delivery: final + wake parent, final on next turn, or pull-only. New tasks inherit configured policy when omitted (`normal` maps to `wake`). Requires a submitted message to a Pi child this session spawned. |

## Resolution chain

`agent get <target>` resolves pane-id / herdr name / label first (and yields
the state the physics branch needs); then the spawn registry (handles of this
session's spawns); then the reserved role `orchestrator` via
`PI_HERDR_ORCHESTRATOR_PANE` (stamped when a pi-herdr agent spawned this
session). A session no agent spawned gets the honest error: *no orchestrator
above you, answer in-conversation*. A `gone` target errors naming the handle
and pointing at `herdr_list_agents`; a queued (accepted-over-the-cap, no pane
yet) spawn has nothing to deliver to and errors the same way.

## Physics-adaptive delivery

- **blocked** target → the **raw text** is typed into its question overlay —
  the message IS the answer (wrapping would pollute the recorded answer).
  Option-list questions still take `herdr_send_keys`; typed text never reaches
  option rows.
- **every other state** → enveloped:
  `<agent-message from="…" to="…">text</agent-message>`. Identity is
  spawner-declared (`PI_HERDR_AGENT_LABEL` → `PI_HERDR_NAME` → pane name →
  pane id → `"session"`), never verified, and there is no child-side parsing —
  the receiving *model* recognizes the tag.

## Receipt (fire-and-forget)

`{delivered: true, target: <resolved pane-id>, to, from, state, delivery:
"message" | "answer", name?, submit, taskId?, notify?}` — no `wait`
(that is `herdr_get_agent_result(wait)`),
and no read receipt: **delivered to the pane ≠ consumed by the model**.
Replies arrive as injected `<agent-message>` text or the next completion
notification.

## Persistent tasks

A persistent Pi child reports settled submitted work once without closing.
After the delivery loop processes its completion (including pull-only `none`),
a submitted message to the idle child starts the next task. A just-settled
completion awaiting delivery refuses a new submission; retry after the next
delivery tick. Mid-work steering and blocked answers coalesce into the current
task; an explicit `notify` changes that task's policy, not a separate reply.
`submit: false` changes neither task nor policy.

One outstanding task per child, one send in flight from this parent. This is
not a broker: other parents and human input are not serialized. Explicit
`notify` on peer/raw or non-Pi panes is refused rather than silently ignored.
