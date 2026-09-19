# Orchestration tools

**Tier 1 — spawn & drive AI agent panes.** These target herdr's **agent surface**
(`agent …`). Eleven tools: the atomic spawn/drive/wait/harvest primitives plus the
composite one-shot `herdr_delegate`.

> Count: **11 tools.** Cross-cutting behavior (envelope, version floor, targeting,
> ⚠️ markers) lives in [concepts](../concepts.md). Pane create/destroy is in
> [pane-sync](pane-sync.md).

---

### `herdr_start_agent`  ·  [Tier 1]

Launch a new AI agent (`pi`/`claude`/`codex`/…) in a herdr pane and return its pane id
and state. One launch path on every OS.

**Wraps:** `pane split --current --direction <right|down> [--cwd --env…] [--focus]`
then `agent start <name> --kind <kind> --pane <id> [-- <agentArgs>]`, retrying
briefly while the freshly-split shell reaches its prompt (`agent_pane_busy`).
herdr resolves the kind to its CLI itself — no platform argv handling on our side.

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `name` | string | no | Agent pane name (must be unique). Default `agent-<timestamp>`. Lowercase `[a-z0-9-_]`. |
| `agent` | string | no | Agent kind (default `pi`). Live-validated against `herdr agent` kinds; unknown → `VALIDATION_ERROR`. |
| `agentArgs` | string[] | no | Extra flags appended to the agent CLI after launch (after `--` in `agent start`), e.g. `["-ne","-e","./src/index.ts"]` to load a local extension. |
| `cwd` | string | no | Working directory for the agent process. |
| `split` | enum `right` \| `down` | no | Split direction relative to the current pane. |
| `tabId` | string | no | Ignored — `pane split` has no tab targeting; the pane lands in the current tab. |
| `workspaceId` | string | no | Ignored — `pane split` has no workspace targeting; the pane lands in the current tab. |
| `env` | record<string,string> | no | Extra env vars (`KEY=VALUE`) for the agent. |
| `focus` | boolean | no | Focus the new pane (default false). |

**Returns:** `okText("Started <kind> agent \"<name>\" in pane <id>.", {…normalizedAgent})`
on success; on error likely `VALIDATION_ERROR` (unknown kind), `HERDR_UNAVAILABLE`,
`HERDR_TOO_OLD` (below the version floor), `PANE_GONE` (split returned no id), or
the `agent start` error.

**Example**

```text
herdr_start_agent  name="helper"  agent="claude"  cwd="/repo"  split="down"
```

**Notes:** `agentArgs` is the supported way to load a local extension — the removed
`custom`/`argv` surface is gone. On macOS, if herdr runs under launchd's minimal
PATH, inject `PATH` via `env` so node-based agents find `node`.

---

### `herdr_send_prompt`

Send a prompt to an agent pane; with `submit=true` (default) the text is also submitted
(Enter). Use to drive an agent you started with `herdr_start_agent`.

**Wraps:** resolves `target` → pane id via `agent get <target>`, then:
submit → `agent prompt <id> <text>`; text-only → `pane send-text <id> <text>`.

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `target` | string | yes | Pane id (`w1:p3`), agent name, or label. |
| `text` | string | yes | Prompt text to type. |
| `submit` | boolean | no | Press Enter to submit (default true). |

**Returns:** `okText("Sent prompt to \"<target>\" (pane <id>) and submitted.", {paneId, submitted})`
(or `… (text only, not submitted).`); on error likely `NOT_FOUND` (target unresolved)
or the underlying send error code.

**Example**

```text
herdr_send_prompt  target="helper"  text="run the test suite"  submit=true
```

**Notes:** This only types/submits — it does **not** wait for the turn to finish. Follow
with `herdr_wait_agent` + `herdr_read_agent`, or use `herdr_delegate` for the whole
cycle in one call.

**Multi-choice overlays *(v0.4.0, validated):*** pi's ask-user overlay is freeform *or*
an option list — and **typed text never reaches an option list** (focus is the list):
bare `Enter` submits option 1 (preselected), `down`×n then `Enter` selects option n+1.
Use `herdr_send_prompt` for freeform answers; select options with `herdr_send_keys`
(`["enter"]` / `["down","enter"]`).

---

### `herdr_read_agent`

Read recent/visible output text from an agent pane. Returns the text and whether it was
truncated.

**Wraps:** `agent read <target> --source <s> --lines <n> --format <f>` (raw text allowed).

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `target` | string | yes | Pane id, agent name, or label (herdr resolves it). |
| `source` | enum `recent` \| `visible` \| `recent-unwrapped` | no | Output source (default `recent`). |
| `lines` | integer | no | Max lines to read (default 50). |
| `format` | enum `text` \| `ansi` | no | Output format (default `text`). |

**Returns:** `okText(<text> || "(no output)", {paneId, text, truncated})`; on error the
mapped code (e.g. `NOT_FOUND`).

**Example**

```text
herdr_read_agent  target="helper"  source="recent"  lines="80"
```

**Notes:** Read is non-blocking and safe to call any time — including on timeout — to
harvest partial output. **Alternate-screen limitation *(v0.4.0)*:** alternate-screen TUIs
(pi, claude, …) do not put scrolled-off content into the host scrollback — if
`truncated` is `true` and raising `lines` doesn't reveal more, ask the agent to write
its full response as Markdown to a temp file and reply with only the path, then read
the file directly.

---

### `herdr_wait_agent`

Block until an agent pane reaches a given status (`idle`/`working`/`blocked`/`done`).
Tolerates the brief `unknown` window right after spawn. Returns `TIMEOUT` on expiry.

**Wraps:** `idle`/`done` race two transition waits plus a polling
`agent get` fallback (self-report yields `done`, auto-detect yields `idle`).
`working`/`blocked`/`unknown` use a single transition wait:
`agent wait <target> --until <s> [--until <s>…] --timeout <ms>`.

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `target` | string | yes | Pane id, agent name, or label. |
| `status` | enum `idle` \| `working` \| `blocked` \| `done` \| `unknown` | yes | Status to wait for. |
| `timeoutMs` | integer | no | Max wait in ms (default 60000). |

**Returns:** `okText("Agent \"<target>\" reached status \"<s>\".", {paneId, agentStatus})`;
on error likely `TIMEOUT` (budget/abort), or `NOT_FOUND`.

**Example**

```text
herdr_wait_agent  target="helper"  status="idle"  timeoutMs="300000"
```

**Notes:** Completion is read from herdr's state events, never inferred from the rendered
spinner (tool-call output replaces it mid-work). The polling fallback makes this robust
even when the event command never fires (e.g. a `done`/`idle` state herdr doesn't
derive). Waiting for `unknown` is rarely useful — it's the brief post-spawn state.

---

### `herdr_list_agents`

List all agents currently running in herdr with their status.

**Wraps:** `agent list`.

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| — | | | No parameters. |

**Returns:** `okText("<n> agent(s):\n- <pane> [<status>] <name> (<kind>)…" || "No agents running.", {agents:[…]})`;
on error the mapped code.

**Example**

```text
herdr_list_agents
```

**Notes:** Distinct from `herdr_list_panes` (Tier 2), which lists **all** panes
including raw non-agent terminals, and from `herdr_session_list` (Tier 5), which lists
named persistent sessions.

---

### `herdr_get_agent`

Get details of a single agent pane by id/name/label.

**Wraps:** `agent get <target>`.

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `target` | string | yes | Pane id, agent name, or label. |

**Returns:** `okText("Agent \"<name>\" (<kind>): pane <id>, status <status>.", {…normalizedAgent})`;
on error likely `NOT_FOUND`.

**Example**

```text
herdr_get_agent  target="helper"
```

**Notes:** Also used internally to resolve a flexible `target` (name/label) to a
concrete pane id before other orchestration tools act.

---

### `herdr_stop_agent`  ·  [Tier 1]  ·  ⚠️ destructive

⚠️ Closes the agent's pane and **terminates the agent process**. Use when an agent is
stuck or no longer needed.

**Wraps:** resolves `target` → pane id via `agent get`, then `pane close <id>`.

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `target` | string | yes | Pane id, agent name, or label. |

**Returns:** `okText("Closed pane <id> (\"<target>\").", {paneId, stopped:true})`; on
error likely `NOT_FOUND`.

**Example**

```text
herdr_stop_agent  target="helper"
```

**Notes:** Same `pane close` primitive as `herdr_close_pane` (Tier 3); this one resolves
a name/label first. To interrupt without killing, use `herdr_send_keys` with
`["ctrl+c"]` (`agentScope:true`).

---

### `herdr_rename_agent`

Rename an agent pane, or clear its name.

**Wraps:** `agent rename <target> <name>` (or `agent rename <target> --clear` when
`name` is empty/omitted).

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `target` | string | yes | Pane id, agent name, or label. |
| `name` | string | no | New name; omit or set empty to clear. Lowercase `[a-z0-9-_]`. |

**Returns:** `okText("Renamed \"<target>\" -> \"<newName>\"." || "… -> \"(cleared)\".", {paneId, name})`;
on error the mapped code.

**Example**

```text
herdr_rename_agent  target="w1:p3"  name="reviewer"
```

**Notes:** After renaming, the new `name` is usable as a `target` by later calls.

---

### `herdr_focus_agent`

Focus an agent pane in the herdr UI.

**Wraps:** `agent focus <target>`.

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `target` | string | yes | Pane id, agent name, or label. |

**Returns:** `okText("Focused pane \"<target>\".", {paneId, focused:true})`; on error
the mapped code.

**Example**

```text
herdr_focus_agent  target="helper"
```

**Notes:** UI-only; does not change agent state.

---

### `herdr_explain_agent`

Get a natural-language explanation of what an agent pane is/does.

**Wraps:** `agent explain <target>` (raw text allowed).

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `target` | string | yes | Pane id, agent name, or label. |

**Returns:** `okText(<explanation> || "(no explanation)", {target, explanation})`; on
error the mapped code.

**Example**

```text
herdr_explain_agent  target="w1:p3"
```

**Notes:** Useful when a snapshot/list shows a pane you don't recognize — herdr explains
its detected kind and lifecycle state.

---

### `herdr_delegate`

Spawn a fresh agent, send a prompt, wait for it to finish, and return its response text —
all in one call. The default is to keep the pane alive for follow-ups (set `closeOnSuccess`
to close it).

**Wraps:** composite — `herdr_start_agent` → boot-wait for `idle` → submit+wait → `agent read`.
Submit+wait is one atomic `agent prompt <id> <text> --wait --timeout <ms>`
(`agent_prompt_stalled` falls back to the wait/poll dance; the turn is re-sent up to
3× if it never starts).
Final read is `agent read <id> --source recent --lines 50 --format text`.
After the turn settles the live `agent_status` is re-checked, so an ask-user `blocked`
state is never mistaken for a finished answer (see `onBlocked`).

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `prompt` | string | yes | Prompt to send to the spawned agent. |
| `name` | string | no | Agent pane name (default `delegate-<timestamp>`). |
| `agent` | string | no | Agent kind (default `pi`); live-validated against the kinds list. |
| `agentArgs` | string[] | no | Extra agent-CLI flags, e.g. to load a local extension. |
| `cwd` | string | no | Working directory for the agent. |
| `timeoutMs` | integer | no | Overall budget in ms (default 120000). |
| `closeOnSuccess` | boolean | no | Close the pane after a successful response (default false, keep alive). |
| `onBlocked` | enum `wait` \| `return` | no | What to do if the spawned agent blocks on `ask_user`. **`"wait"`** (default): hold the call open with **no time bound** (only the parent abort stops it) until a human answers in the spawned pane, then return the final answer. **`"return"`**: return immediately with `{blocked:true, question, paneId}` (`isError`, pane kept alive) for the orchestration session to relay via its own `ask_user` → `herdr_send_prompt` → `herdr_wait_agent` → `herdr_read_agent`. `timeoutMs` does **not** bound the `"wait"` phase. *(v0.3.0)* |
| `env` | record<string,string> | no | Extra env vars. On macOS, set `PATH` to your shell PATH if herdr runs under launchd's minimal PATH. |

**Returns:** `okText(<response> || "(agent produced no captured output)", {paneId, name, response, closed})`
on success; on failure a `partial(...)` (`isError:true`) carrying whatever response was
read plus `{paneId, name, response, error}` — error codes include `TIMEOUT` and the
start-failure codes.

**Example**

```text
herdr_delegate  prompt="Write tests for auth.ts and summarize what you changed."  agent="pi"  timeoutMs="180000"
```

**Notes:** `herdr_delegate` calls run concurrently — fan out N at once for parallel work
(pair with `herdr_worktree_create` to give each its own checkout). The boot gate waits up
to 90 s for `idle` because a spawned pi that inherits host extensions/skills can spend
~40–60 s in `unknown` first. If the turn times out, the pane is left alive with partial
output for inspection.

**Blocked (ask-user) handling:** `agent prompt --wait` settles on
`blocked` too (the spawned agent is waiting on `ask_user`) and returns ok — so a plain
`done.ok` check can't tell "answered" from "waiting for a human". The delegate re-reads
`agent get` after the turn settles and branches on `onBlocked` (above). With `"return"`,
the returned text is the agent's **question**, not an answer — the prompt guideline tells
the orchestrator to relay it. **Overlay semantics *(v0.4.0, validated empirically):***
pi's ask-user overlay is freeform *or* multi-choice, and **typed text never reaches an
option list** — bare `Enter` selects option 1 (preselected), `down`×n then `Enter`
selects option n+1; typed text only lands in a focused freeform row. So answer freeform
overlays with `herdr_send_prompt` (text + Enter) and multi-choice overlays with
`herdr_send_keys` (`["enter"]` / `["down","enter"]`).
