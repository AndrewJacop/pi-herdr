# Tab tools

**Tier 2 — tab operations** (list/create/get/focus/rename/close). herdr organizes the UI
as **workspaces → tabs → panes**; these manage the tab level.

> Count: **6 tools.** Panes are in [panes](panes.md) (+ [pane-sync](pane-sync.md)
> for create/destroy); workspaces in [workspaces](workspaces.md). See [concepts](../concepts.md).

---

### `herdr_list_tabs`

List tabs in a workspace. Returns each tab's id, label, number, pane count, and focus.

**Wraps:** `tab list [--workspace <id>]`.

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `workspaceId` | string | no | Limit to a workspace id (e.g. `w1`). |

**Returns:** `okText("<n> tab(s):\n- <id> #<n> \"<label>\" <panes> pane(s) (focused)…" || "No tabs.", {tabs:[…]})`;
on error the mapped code.

**Example**

```text
herdr_list_tabs  workspaceId="w1"
```

**Notes:** Omits `workspaceId` to list tabs across all workspaces.

---

### `herdr_create_tab`

Create a new tab (optionally in a specific workspace, with a cwd/label/env, focused or
not). Returns the new tab id.

**Wraps:** `tab create [--workspace <id>] [--cwd <dir>] [--label <s>] [--env KEY=VALUE…] [--focus|--no-focus]`.

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `workspaceId` | string | no | Workspace to create the tab in (default: current). |
| `cwd` | string | no | Working directory for the tab's shell. |
| `label` | string | no | Tab label. |
| `env` | record<string,string> | no | Extra env vars (`KEY=VALUE`) for the tab's shell. |
| `focus` | boolean | no | Focus the new tab (default herdr-determined → flag omitted). |

**Returns:** `okText("Created tab <id>.", {tabId})`; on error likely `PANE_GONE` (create
returned no tab id) or the mapped code.

**Example**

```text
herdr_create_tab  workspaceId="w1"  label="build"  cwd="/repo"
```

**Notes:** `focus` maps to `--focus`/`--no-focus`; leaving it undefined omits the flag so
herdr picks the default. A new tab starts with one shell pane — spawn an agent or run a
command into it afterward.

---

### `herdr_get_tab`

Show details of a single tab by id.

**Wraps:** `tab get <tabId>`.

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `tabId` | string | yes | Tab id (e.g. `w1:t1`). |

**Returns:** `okText("Tab <id>: #<n> \"<label>\" <panes> pane(s) workspace=<ws> (focused).", {…normalizedTab})`;
on error likely `NOT_FOUND`.

**Example**

```text
herdr_get_tab  tabId="w1:t1"
```

**Notes:** Reports pane count and parent workspace, useful before a destructive close.

---

### `herdr_focus_tab`

Focus a tab in the herdr UI.

**Wraps:** `tab focus <tabId>`.

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `tabId` | string | yes | Tab id to focus. |

**Returns:** `okText("Focused tab <id>.", {tabId, focused:true})`; on error likely `NOT_FOUND`.

**Example**

```text
herdr_focus_tab  tabId="w1:t2"
```

**Notes:** UI-only; does not change any pane/agent state.

---

### `herdr_rename_tab`

Rename a tab.

**Wraps:** `tab rename <tabId> <label>`.

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `tabId` | string | yes | Tab id to rename. |
| `label` | string | yes | New tab label. |

**Returns:** `okText("Renamed tab <id> -> \"<label>\".", {tabId, label})`; on error likely
`VALIDATION_ERROR` (empty `label`) or the mapped code.

**Example**

```text
herdr_rename_tab  tabId="w1:t1"  label="tests"
```

**Notes:** An empty `label` is rejected client-side as `VALIDATION_ERROR` (unlike
`herdr_rename_agent`, which clears the name when given empty).

---

### `herdr_close_tab`  ·  [Tier 2]  ·  ⚠️ destructive

⚠️ Closes a tab by id and **terminates every pane in it**.

**Wraps:** `tab close <tabId>`.

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `tabId` | string | yes | Tab id to close. |

**Returns:** `okText("Closed tab <id>.", {tabId, closed:true})`; on error likely `NOT_FOUND`.

**Example**

```text
herdr_close_tab  tabId="w1:t2"
```

**Notes:** Cascades to all panes inside the tab. To close a single pane, use
`herdr_close_pane` / `herdr_stop_agent`; to close an entire workspace, use
`herdr_close_workspace`.
