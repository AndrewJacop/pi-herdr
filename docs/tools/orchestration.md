# Agent tools

**The kept agent surface.** These target herdr's **agent surface**
(`agent …`). Three tools after the v0.6 substrate (issue 04):
`herdr_get_agent_result` (the result tool — exact session-file reads),
`herdr_send_prompt` (steering; absorbed by `herdr_message_agent` in a later
ticket), and `herdr_list_agents` (the fleet's single introspection tool). The
spawn entry point is [`herdr_spawn_agent`](../README.md#tools), documented in
the project README.

> Count: **3 of the 9 registered tools.** Cross-cutting behavior (envelope,
> version floor, targeting, ⚠️ markers) lives in [concepts](../concepts.md).
> Raw pane control is in [pane-sync](pane-sync.md).

---

### `herdr_get_agent_result`

Pull an agent's result. For **pi children this session spawned**, the source is
the child's parent-owned session file: the exact last assistant message object
— no screen scraping, no tail heuristics, no truncation ambiguity. Mid-flight
calls return an interim snapshot of the message-so-far. A failing child
surfaces as a **typed error** (`stopReason` / `errorMessage`, mined from the
child's completion sidecar or its session). Panes this session did not spawn
(adopted) and non-pi kinds fall back to **pane-tail reading**.

The completion sidecar (`<session>.exit`, written by the injected child
extension) is checked BEFORE pane status: an auto-exited autonomous child is
already gone from the fleet when its typed sidecar lands, and `gone` must not
swallow a finished result. A `gone` answer carries last-known registry
metadata; sessions are never deleted by pi-herdr, so the session file remains
readable and resumable.

**Reads:** the session JSONL directly; sidecar `<session>.exit`;
`agent read` (fallback only).

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `target` | string | yes | Spawn handle (the name `herdr_spawn_agent` returned) or pane id. |
| `wait` | bool \| int | no | `true` = block until done/failed/blocked/gone (through the queue); a number = bounded wait, current state on expiry. |
| `lines` | int | no | Pane-tail line budget for the unspawned fallback (default 80). |

**Statuses (coarse until the 07 projection):** `queued` · `working` · `idle` ·
`done` · `blocked` · `error` · `gone`. `details` carries the full envelope:
`result` (exact text), `message` (the verbatim message object), `source`
(`session-jsonl` / `pane-tail`), `sessionPath`, `exitPath`, `error`, and
`lastKnown` for `gone`.

> **Retry semantics:** a failed attempt on a live pane is not yet exhaustion —
> the child's grace window lets pi's retry machine run. The tool keeps polling
> (status `working`, typed payload attached) until a sidecar lands or the pane
> exits; only then does it report the terminal `error`.

---

### `herdr_send_prompt`

Send a prompt to an agent pane; submits with Enter by default. Use it to steer
an agent you spawned with `herdr_spawn_agent` — follow-up work, corrections,
or answering its questions (freeform overlays only; see the note below).

**Wraps:** `agent prompt <target> <text>` (submit) or `pane send-text <pane> <text>`
(text only, `submit: false`).

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `target` | string | yes | Pane id (`w1:p3`), agent name, or label. |
| `text` | string | yes | Prompt text to type. |
| `submit` | boolean | no | Press Enter to submit (default true). |

> **Multi-choice overlays:** typed text does NOT reach a pi ask-user option
> list — select with `herdr_send_keys` instead (bare `Enter` picks option 1,
> `down` then `Enter` picks option 2). Typed text only lands in a focused
> freeform row; use `herdr_send_prompt` for those.

---

### `herdr_list_agents`

List every agent currently running in herdr with its status — the fleet's
single introspection tool. Per-agent detail comes from steering the agent, not
from extra tools.

**Wraps:** `agent list`.

**Returns:** one line per agent — `- <paneId> [<status>] <name> (<kind>)` —
plus the normalized list in `details.agents`.

---

## What was cut (v0.6)

`herdr_start_agent`, `herdr_get_agent`, `herdr_stop_agent`,
`herdr_rename_agent`, `herdr_focus_agent`, `herdr_explain_agent`, the
`herdr_delegate` composite, and — with the substrate (issue 04) —
`herdr_wait_agent` + `herdr_read_agent` are **off the model surface**. Their
replacements:

- `herdr_start_agent` / `herdr_delegate` → `herdr_spawn_agent`
  (spawn + submit in one call) + `herdr_get_agent_result`.
- `herdr_get_agent` / `herdr_explain_agent` → `herdr_list_agents`.
- `herdr_stop_agent` → the confirmed **Kill all agents** action in
  `/subagents config` (or close the pane yourself in the herdr UI); for a
  single runaway agent, `herdr_send_keys` with `["ctrl+c"]` interrupts the turn.
- `herdr_rename_agent` / `herdr_focus_agent` → the herdr UI (rename/focus a
  pane yourself); the machinery survives internally.

See the README's [Upgrading](../README.md#upgrading-v05--v06) note.
