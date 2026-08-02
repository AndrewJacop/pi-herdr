# Pane-sync tools

**Tier 3 — run commands in raw terminal panes.** These target herdr's **pane surface**
(`pane …`): split a raw terminal, run a shell command/build/log stream in it, read its
output, wait for a marker, send logical keys, and close it. Use case: `heroku logs
--tail`, a test suite, a dev server — anything that is *not* an AI agent.

> Count: **6 tools.** These commands are **0.7.5-only** — they don't exist on `<0.7.5`,
> where herdr surfaces a server-side error. `herdr_send_keys` and `herdr_close_pane` are
> the pane create/destroy primitives also reused by the layout tier. See [concepts](../concepts.md).

---

### `herdr_split_pane`
Split the current herdr pane (raw terminal, no agent) and return the new pane id. Pair
with `herdr_run_command` to run a shell command, build, or log stream in it.

**Wraps:** 0.7.5-only. `pane split --current --direction <right|down> [--cwd --env…] [--focus]`.

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `direction` | enum `right` \| `down` | no | Split direction relative to the current pane (default `right`). |
| `cwd` | string | no | Working directory for the new pane's shell. |
| `env` | record<string,string> | no | Extra env vars (`KEY=VALUE`) for the new pane. |
| `focus` | boolean | no | Focus the new pane (default false). |

**Returns:** `okText("Split pane <id> (<dir>) from the current pane.", {paneId, direction})`;
on error likely `PANE_GONE` (split returned no pane id) or `HERDR_UNAVAILABLE`.

**Example**
```text
herdr_split_pane  direction="down"  cwd="/repo"
```

**Notes:** This is the **pane surface** — no agent is launched. To launch an AI agent
instead, use `herdr_start_agent` (Tier 1).

---

### `herdr_run_command`
Run a shell command (text + Enter) in a herdr pane — a raw process, not an agent. Use for
logs, test suites, builds, one-off shell commands.

**Wraps:** 0.7.5-only. `pane run <paneId> <command>` (the command is one argv element;
the pane's shell types the line + Enter).

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `paneId` | string | yes | Target pane id (e.g. `w1:p3`). |
| `command` | string | yes | Command line to run (typed, then Enter). |

**Returns:** `okText("Ran command in pane <id>: <command>", {paneId, command})`; on
error the mapped code.

**Example**
```text
herdr_run_command  paneId="w1:p4"  command="npm test"
```

**Notes:** This types into the pane's existing shell. To run a long-lived stream
(`heroku logs --tail`), follow with `herdr_wait_output` / `herdr_read_pane`. This is the
same primitive the Windows launch path uses internally to start agents.

---

### `herdr_read_pane`
Read recent/visible terminal output from a herdr pane (raw terminal, not an agent).
Returns the text and whether it was truncated.

**Wraps:** 0.7.5-only. `pane read <paneId> --source <s> --lines <n> --format <f>` (raw text allowed).

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `paneId` | string | yes | Target pane id. |
| `source` | enum `recent` \| `visible` \| `recent-unwrapped` | no | Output source (default `recent`). |
| `lines` | integer | no | Max lines to read (default 50). |
| `format` | enum `text` \| `ansi` | no | Output format (default `text`). |

**Returns:** `okText(<text> || "(no output)", {paneId, text, truncated})`; on error the
mapped code.

**Example**
```text
herdr_read_pane  paneId="w1:p4"  source="recent"  lines="120"
```

**Notes:** Non-blocking and safe to call on demand. Use `herdr_wait_output` when you need
to block until a specific line appears.

---

### `herdr_wait_output`
Block until a herdr pane emits output matching a literal substring (`--match`) or a regex
(`--regex`). Searches existing output, then polls. Returns the matched line. Useful for
waiting on a server "ready" marker.

**Wraps:** 0.7.5-only. `pane wait-output <paneId> (--match <s> | --regex <r>) [--source <s>] [--lines <n>] --timeout <ms> [--raw]`.

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `paneId` | string | yes | Target pane id. |
| `match` | string | no | Literal substring to match (mutually exclusive with `regex`). |
| `regex` | string | no | Rust regex to match (mutually exclusive with `match`). |
| `source` | enum `recent` \| `visible` \| `recent-unwrapped` | no | Snapshot source to search (default `recent`). |
| `lines` | integer | no | Restrict the searched snapshot to N lines. |
| `timeoutMs` | integer | no | Fail after this many ms (default 30000). |
| `raw` | boolean | no | Keep ANSI escape sequences while matching (default false). |

**Returns:** `okText("Matched in pane <id>: <matchedLine>." || "Matched in pane <id>.", {paneId, matchedLine, read})`;
on error likely `VALIDATION_ERROR` (neither/both of `match`/`regex`) or `TIMEOUT`.

**Example**
```text
herdr_wait_output  paneId="w1:p4"  match="ready in"  timeoutMs="60000"
```

**Notes:** Exactly one of `match`/`regex` is required; passing both (or neither) returns
`VALIDATION_ERROR`. The default 30 s timeout is always emitted so the call can't hang
indefinitely.

---

### `herdr_send_keys`  ·  [Tier 3]  ·  ⚠️ destructive
⚠️ Sends logical key presses (`ctrl+c` interrupts a process, `esc` dismisses, `Enter`).
Send key **names** only — to type text use `herdr_run_command` (pane) or `herdr_send_prompt` (agent).

**Wraps:** 0.7.5-only. `pane send-keys <target> <key> [<key>…]` (default), or
`agent send-keys <target> <key> [<key>…]` when `agentScope:true`.

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `target` | string | yes | Pane id (default) or, with `agentScope`, agent name/label. |
| `keys` | string[] | yes | Logical key names to send, e.g. `["ctrl+c"]`, `["esc"]`, `["Enter"]`. |
| `agentScope` | boolean | no | Target the agent surface (`agent send-keys`) instead of the raw pane (default false). |

**Returns:** `okText("Sent keys […] to pane|agent \"<target>\".", {target, keys, agentScope})`;
on error likely `VALIDATION_ERROR` (empty `keys`) or the mapped code.

**Example**
```text
herdr_send_keys  target="w1:p4"  keys=["ctrl+c"]
herdr_send_keys  target="helper"  keys=["esc"]  agentScope=true
```

**Notes:** The one tool that spans both surfaces — `agentScope` selects
`pane send-keys` vs `agent send-keys`. This is the safe way to unstick a runaway pane
without killing it (contrast `herdr_stop_agent` / `herdr_close_pane`).

---

### `herdr_close_pane`  ·  [Tier 3]  ·  ⚠️ destructive
⚠️ Closes a herdr pane by id and **terminates whatever runs in it**.

**Wraps:** 0.7.5-only. `pane close <paneId>`.

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `paneId` | string | yes | Pane id to close. |

**Returns:** `okText("Closed pane <id>.", {paneId, closed:true})`; on error likely `NOT_FOUND`.

**Example**
```text
herdr_close_pane  paneId="w1:p4"
```

**Notes:** Same `pane close` primitive as `herdr_stop_agent` (Tier 1); this one takes a
raw pane id directly (no name/label resolution). Close a **tab** or **workspace** instead
to terminate everything beneath it (Tier 2).
