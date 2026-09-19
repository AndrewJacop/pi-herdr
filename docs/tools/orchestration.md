# Agent tools

**The kept agent surface.** These target herdr's **agent surface**
(`agent …`). Four tools after the v0.6 surface cut: the result trio
(`herdr_send_prompt`, `herdr_wait_agent`, `herdr_read_agent` — retired by
`herdr_get_agent_result` when the substrate lands) plus `herdr_list_agents`
(the fleet's single introspection tool). The spawn entry point is
[`herdr_spawn_agent`](../README.md#tools), documented in the project README.

> Count: **4 of the 9 registered tools.** Cross-cutting behavior (envelope,
> version floor, targeting, ⚠️ markers) lives in [concepts](../concepts.md).
> Raw pane control is in [pane-sync](pane-sync.md).

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

### `herdr_wait_agent`

Block until an agent pane reaches a status (`idle`/`working`/`blocked`/`done`).
Tolerates the brief `unknown` window right after spawn. Returns `TIMEOUT` on
expiry.

**Wraps:** `agent wait <target> --until <s>… --timeout <ms>` for
working/blocked/unknown; for idle/done the engine races the transition waits
against a polling `agent get` fallback (an already-settled pane has no
transition to fire — the poll catches it).

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `target` | string | yes | Pane id, agent name, or label. |
| `status` | enum | yes | `idle` \| `working` \| `blocked` \| `done` \| `unknown`. |
| `timeoutMs` | int | no | Max wait in ms (default 60000). |

---

### `herdr_read_agent`

Read recent/visible output text from an agent pane. Returns the text and
whether it was truncated.

**Wraps:** `agent read <target> --source <s> --lines <n> --format <f>`.

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `target` | string | yes | Pane id, agent name, or label. |
| `source` | enum | no | `recent` (default) \| `visible` \| `recent-unwrapped`. |
| `lines` | int | no | Max lines to read (default 50). |
| `format` | enum | no | `text` (default) \| `ansi`. |

> **Alternate-screen scrollback limit:** alternate-screen TUIs (pi, claude, …)
> keep long answers off the host scrollback. If `truncated: true` and raising
> `lines` doesn't help, ask the agent to write its full response to a file and
> reply with the path, then read the file.

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
`herdr_rename_agent`, `herdr_focus_agent`, `herdr_explain_agent`, and the
`herdr_delegate` composite are **off the model surface**. Their replacements:

- `herdr_start_agent` / `herdr_delegate` → `herdr_spawn_agent`
  (spawn + submit in one call) + `herdr_wait_agent` + `herdr_read_agent`.
- `herdr_get_agent` / `herdr_explain_agent` → `herdr_list_agents`.
- `herdr_stop_agent` → the confirmed **Kill all agents** action in
  `/subagents config` (or close the pane yourself in the herdr UI); for a
  single runaway agent, `herdr_send_keys` with `["ctrl+c"]` interrupts the turn.
- `herdr_rename_agent` / `herdr_focus_agent` → the herdr UI (rename/focus a
  pane yourself); the machinery survives internally.

See the README's [Upgrading](../README.md#upgrading-v05--v06) note.
