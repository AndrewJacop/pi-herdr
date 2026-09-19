# Introspection tools

**Tier 5 — live snapshot + named sessions.** Two surfaces: `api snapshot` (the whole
live fleet) and `session …` (herdr's *named persistent sessions*, distinct from per-pane
agent state). `session attach` is interactive (TUI) and is therefore **excluded** from
the tool surface.

> Count: **4 tools.** `--json` is always emitted (where supported) so the
> envelope parser returns structured data. See [concepts](../concepts.md).

---

### `herdr_api_snapshot`

Read the full live herdr session snapshot — every workspace, tab, pane, and agent with its
state, plus focused ids and server version/protocol. The whole-fleet view for routing
decisions.

**Wraps:** `api snapshot` (no flags — JSON is the only output form).

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| — | | | No parameters. |

**Returns:** `okText("Live snapshot: herdr <ver> \| <ws> workspace(s), <tabs> tab(s), <panes> pane(s), <agents> agent(s)[ \| <n> working][ \| focused=<pane>].", {summary, snapshot})`
— `summary` holds counts + focused ids; `snapshot` holds the full payload; on error the
mapped code.

**Example**

```text
herdr_api_snapshot
```

**Notes:** The most efficient single call to decide where to route work — it includes
agent statuses and counts working agents. The narrower per-level lists
(`herdr_list_workspaces` / `_tabs` / `_panes` / `_agents`) are lighter when you only need
one level.

---

### `herdr_session_list`

List herdr named persistent sessions. Returns each session's name, running state, default
flag, and socket path. (Distinct from per-pane agent state — use `herdr_list_agents` for that.)

**Wraps:** `session list --json`.

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| — | | | No parameters. |

**Returns:** `okText("<n> session(s):\n- <name>[ (default)][ running|stopped]…" || "No sessions.", {sessions:[…]})`;
on error the mapped code.

**Example**

```text
herdr_session_list
```

**Notes:** A "session" here is herdr's named persistent session (its server + all
panes/tabs), **not** an agent's `idle`/`working`/`blocked` state. Use `herdr_list_agents`
for agent states.

---

### `herdr_session_stop`  ·  [Tier 5]  ·  ⚠️ destructive

⚠️ Stops a running named herdr session — **terminates its server and every pane/tab in it**.
Not the same as closing one pane; this ends the whole session.

**Wraps:** `session stop <name> --json`.

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `name` | string | yes | Session name to stop. |

**Returns:** `okText("Stopped session \"<name>\".", {name, stopped:true})`; on error likely
`VALIDATION_ERROR` (empty `name`) or a herdr server error (e.g. session not running).

**Example**

```text
herdr_session_stop  name="throwaway"
```

**Notes:** List names first with `herdr_session_list`. A stopped session's directory still
exists on disk; remove it with `herdr_session_delete`. This is far more destructive than
`herdr_close_workspace` — it tears down the session server itself.

---

### `herdr_session_delete`  ·  [Tier 5]  ·  ⚠️ destructive

⚠️ Deletes a stopped herdr session and **removes its on-disk directory** (permanent). The
session must be stopped first — use `herdr_session_stop`.

**Wraps:** `session delete <name> --json`.

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `name` | string | yes | Session name to delete. |

**Returns:** `okText("Deleted session \"<name>\".", {name, deleted:true})`; on error likely
`VALIDATION_ERROR` (empty `name`) or a herdr server error (e.g. session still running).

**Example**

```text
herdr_session_delete  name="throwaway"
```

**Notes:** herdr only deletes **stopped** sessions — deleting a running one surfaces a
server error, so `herdr_session_stop` it first. The removal is permanent (the session
directory is gone). List first with `herdr_session_list`.
