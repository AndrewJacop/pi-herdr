# Workspace tools

**Tier 2 — workspace operations** (list/create/get/focus/rename/close). A workspace is
the top level of herdr's **workspaces → tabs → panes** hierarchy; it can hold multiple
tabs.

> Count: **6 tools.** Tabs are in [tabs](tabs.md); panes in [panes](panes.md)
> (+ [pane-sync](pane-sync.md) for create/destroy). See [concepts](../concepts.md).

---

### `herdr_list_workspaces`

List all workspaces. Returns each workspace's id, label, number, tab/pane counts, active
tab, and focus.

**Wraps:** `workspace list`.

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| — | | | No parameters. |

**Returns:** `okText("<n> workspace(s):\n- <id> #<n> \"<label>\" <tabs> tab(s)/<panes> pane(s) active=<tab> (focused)…" || "No workspaces.", {workspaces:[…]})`;
on error the mapped code.

**Example**

```text
herdr_list_workspaces
```

**Notes:** `herdr_api_snapshot` (Tier 5) gives the whole-fleet view including focused ids
and server version; this is the lightweight workspace-only list.

---

### `herdr_create_workspace`

Create a new workspace (optionally with a cwd/label/env, focused or not). Returns the new
workspace id.

**Wraps:** `workspace create [--cwd <dir>] [--label <s>] [--env KEY=VALUE…] [--focus|--no-focus]`.

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `cwd` | string | no | Working directory for the workspace. |
| `label` | string | no | Workspace label. |
| `env` | record<string,string> | no | Extra env vars (`KEY=VALUE`) for the workspace. |
| `focus` | boolean | no | Focus the new workspace (default herdr-determined → flag omitted). |

**Returns:** `okText("Created workspace <id>.", {workspaceId})`; on error likely `PANE_GONE`
(create returned no workspace id) or the mapped code.

**Example**

```text
herdr_create_workspace  label="review"  cwd="/repo"
```

**Notes:** There is no `--workspace` parent (workspaces are top-level). A new workspace
starts with one tab/pane. For a parallel git checkout instead, use `herdr_worktree_create`.

---

### `herdr_get_workspace`

Show details of a single workspace by id.

**Wraps:** `workspace get <workspaceId>`.

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `workspaceId` | string | yes | Workspace id (e.g. `w1`). |

**Returns:** `okText("Workspace <id>: #<n> \"<label>\" <tabs> tab(s)/<panes> pane(s) active=<tab> (focused).", {…normalizedWorkspace})`;
on error likely `NOT_FOUND`.

**Example**

```text
herdr_get_workspace  workspaceId="w1"
```

**Notes:** Reports tab/pane counts and the active tab — useful before a destructive close.

---

### `herdr_focus_workspace`

Focus a workspace in the herdr UI.

**Wraps:** `workspace focus <workspaceId>`.

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `workspaceId` | string | yes | Workspace id to focus. |

**Returns:** `okText("Focused workspace <id>.", {workspaceId, focused:true})`; on error
likely `NOT_FOUND`.

**Example**

```text
herdr_focus_workspace  workspaceId="w2"
```

**Notes:** UI-only; does not change any tab/pane/agent state.

---

### `herdr_rename_workspace`

Rename a workspace.

**Wraps:** `workspace rename <workspaceId> <label>`.

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `workspaceId` | string | yes | Workspace id to rename. |
| `label` | string | yes | New workspace label. |

**Returns:** `okText("Renamed workspace <id> -> \"<label>\".", {workspaceId, label})`; on
error likely `VALIDATION_ERROR` (empty `label`) or the mapped code.

**Example**

```text
herdr_rename_workspace  workspaceId="w1"  label="main"
```

**Notes:** An empty `label` is rejected client-side as `VALIDATION_ERROR` (unlike
`herdr_rename_agent`, which clears the name when given empty).

---

### `herdr_close_workspace`  ·  [Tier 2]  ·  ⚠️ destructive

⚠️ Closes a workspace by id and **terminates every tab and pane in it**.

**Wraps:** `workspace close <workspaceId>`.

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `workspaceId` | string | yes | Workspace id to close. |

**Returns:** `okText("Closed workspace <id>.", {workspaceId, closed:true})`; on error
likely `NOT_FOUND`.

**Example**

```text
herdr_close_workspace  workspaceId="w3"
```

**Notes:** The most destructive layout op — it cascades through all tabs and panes. Prefer
closing individual tabs/panes when you only want to reclaim part of a workspace. Distinct
from `herdr_session_stop` (Tier 5), which ends a whole named session.
