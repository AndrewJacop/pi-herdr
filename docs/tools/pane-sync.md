# Pane-sync tools

**The pane-sync quartet — run commands in raw terminal panes.** These target
herdr's **pane surface** (`pane …`): run a shell command/build/log stream in
an existing pane, read its output, wait for a marker, send logical keys. Use
case: `heroku logs --tail`, a test suite, a dev server — anything that is
*not* an AI agent.

> Count: **4 tools.** These commands are current-surface herdr (≥ 0.9.0 is the
> version floor; anything older refuses with `HERDR_TOO_OLD`). Panes are
> addressed by id — pane/tab/workspace CRUD is off the model surface (v0.6
> surface cut); open and arrange panes yourself in the herdr UI. See
> [concepts](../concepts.md).

---

### `herdr_run_command`

Run a shell command (text + Enter) in a herdr pane — a raw process, not an
agent. Use for logs, test suites, builds, one-off shell commands.

**Wraps:** `pane run <paneId> <command>` (the command is one argv element;
the pane's shell types the line + Enter).

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `paneId` | string | yes | Target pane id (e.g. `w1:p3`). |
| `command` | string | yes | Command line to run (typed, then Enter). |

**Returns:** `okText("Ran command in pane <id>: <command>", {paneId, command})`; on
error the mapped code.

---

### `herdr_read_pane`

Read recent/visible terminal output from a herdr pane (raw terminal, not an
agent). Returns the text and whether it was truncated.

**Wraps:** `pane read <paneId> --source <s> --lines <n> --format <f>`.

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `paneId` | string | yes | Target pane id. |
| `source` | enum | no | `recent` (default) \| `visible` \| `recent-unwrapped`. |
| `lines` | int | no | Max lines to read (default 50). |
| `format` | enum | no | `text` (default) \| `ansi`. |

---

### `herdr_wait_output`

Block until a herdr pane emits output matching a literal substring (`match`)
or a regex (`regex`). Searches existing output, then polls. Returns the
matched line. Useful for waiting on a server `ready` marker.

**Wraps:** `pane wait-output <paneId> (--match <s> | --regex <r>) [--source <s>]
[--lines <n>] --timeout <ms> [--raw]`. Exactly one of `match`/`regex`
(mutually exclusive — `VALIDATION_ERROR` otherwise). The timeout is always
emitted (herdr waits indefinitely without it).

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `paneId` | string | yes | Target pane id. |
| `match` | string | no | Literal substring to match (xor `regex`). |
| `regex` | string | no | Rust regex to match (xor `match`). |
| `source` | enum | no | Snapshot source to search (default `recent`). |
| `lines` | int | no | Restrict the searched snapshot to N lines. |
| `timeoutMs` | int | no | Fail after this many ms (default 30000). |
| `raw` | boolean | no | Keep ANSI escape sequences while matching (default false). |

---

### `herdr_send_keys` ⚠️

Send logical key presses (e.g. `ctrl+c`, `esc`, `Enter`) to a pane. By default
targets the raw pane surface (`paneId`); set `agentScope` to target an agent
by name/label. Use `herdr_run_command` / `herdr_send_prompt` to type TEXT —
this only sends key NAMES. Labeled ⚠️ because `ctrl+c` interrupts a process.

**Wraps:** `pane send-keys <paneId> <keys…>` or (with `agentScope`)
`agent send-keys <target> <keys…>`.

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `target` | string | yes | Pane id (default) or, with `agentScope`, agent name/label. |
| `keys` | string[] | yes | Logical key names, e.g. `["ctrl+c"]`, `["esc"]`, `["Enter"]`. |
| `agentScope` | boolean | no | Target the agent surface instead of the raw pane (default false). |

> **Multi-choice overlays:** typed text does NOT reach a pi ask-user option
> list — bare `Enter` selects option 1 (preselected), `down`×n then `Enter`
> selects option n+1. This is the documented way to answer a blocked agent's
> option question (see [agent tools](orchestration.md#herdr_send_prompt)).

---

## What was cut (v0.6)

`herdr_split_pane` and `herdr_close_pane` are **off the model surface**:
open and close panes yourself in the herdr UI. The pane-focus and pane-close
machinery survives internally (kill-all, pane lifecycle). See the README's
[Upgrading](../README.md#upgrading-v05--v06) note.
