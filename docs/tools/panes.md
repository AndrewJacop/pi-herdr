# Pane tools

**Tier 2 — pane layout operations** (list/get/resize/zoom/move/swap). These target
herdr's **pane surface** and operate on existing panes.

> Count: **6 tools.** Pane **create/destroy** (`herdr_split_pane`,
> `herdr_close_pane`) lives in [pane-sync](pane-sync.md) and is reused, not re-defined
> here. Tabs are in [tabs](tabs.md); workspaces in [workspaces](workspaces.md). See
> [concepts](../concepts.md).

---

### `herdr_list_panes`

List panes (raw terminals and agent panes) in a workspace. Returns each pane's id, agent
kind, status, cwd, and focus.

**Wraps:** `pane list [--workspace <id>]`.

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `workspaceId` | string | no | Limit to a workspace id (e.g. `w1`). |

**Returns:** `okText("<n> pane(s):\n- <id> [<status>] <kind> (focused) <cwd>…" || "No panes.", {panes:[…]})`;
on error the mapped code.

**Example**

```text
herdr_list_panes  workspaceId="w1"
```

**Notes:** Lists **all** panes — both raw terminals and AI-agent panes. For agents only,
use `herdr_list_agents` (Tier 1).

---

### `herdr_get_pane`

Show details of a single pane by id.

**Wraps:** `pane get <paneId>`.

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `paneId` | string | yes | Pane id (e.g. `w1:p3`). |

**Returns:** `okText("Pane <id>: <kind|no agent> [<status>] (focused) cwd=<cwd> tab=<tab> workspace=<ws>.", {…normalizedAgent})`;
on error likely `NOT_FOUND`.

**Example**

```text
herdr_get_pane  paneId="w1:p3"
```

**Notes:** Returns agent kind/status when the pane hosts an agent, otherwise `no agent`.

---

### `herdr_resize_pane`

Resize a pane split by moving an edge in a direction. Targets the focused pane by
default, or a specific `paneId`.

**Wraps:** `pane resize --direction <d> [--amount <f>] (--pane <id> | --current)`.

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `direction` | enum `left` \| `right` \| `up` \| `down` | yes | Edge to move when resizing. |
| `amount` | number | no | How far to move the edge (float; herdr default if omitted). |
| `paneId` | string | no | Pane to resize (default: the focused pane → `--current`). |

**Returns:** `okText("Resized pane <id| (focused)> <direction>[ by <amount>].", {paneId, direction, amount})`;
on error the mapped code.

**Example**

```text
herdr_resize_pane  direction="down"  amount="0.3"  paneId="w1:p3"
```

**Notes:** `direction` is the edge to move, not the pane to grow — e.g. `down` moves the
bottom edge. Omitting `paneId` acts on the currently focused pane.

---

### `herdr_zoom_pane`

Toggle, enable, or disable pane zoom (full-pane focus within a split). Targets the
focused pane by default, or a specific `paneId`.

**Wraps:** `pane zoom (--toggle|--on|--off) (--pane <id> | --current)`.

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `mode` | enum `toggle` \| `on` \| `off` | no | Zoom action (default `toggle`). |
| `paneId` | string | no | Pane to zoom (default: the focused pane → `--current`). |

**Returns:** `okText("Zoom <mode> applied to pane <id| (focused)>.", {paneId, mode})`;
on error the mapped code.

**Example**

```text
herdr_zoom_pane  mode="on"  paneId="w1:p3"
```

**Notes:** Zoom is a UI view state, not a layout change.

---

### `herdr_move_pane`

Move a pane to another tab/workspace, or next to a target pane. Supports splitting
direction and ratio at the destination, or opening a new tab/workspace.

**Wraps:** `pane move <paneId> [--tab <id>] [--split <right|down>] [--target-pane <id>] [--ratio <f>] [--new-tab] [--workspace <id>] [--new-workspace]`.

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `paneId` | string | yes | Pane to move. |
| `tabId` | string | no | Destination tab id. |
| `split` | enum `right` \| `down` | no | Split direction at the destination. |
| `targetPane` | string | no | Place next to this pane id. |
| `ratio` | number | no | Split ratio at the destination (float). |
| `newTab` | boolean | no | Move into a newly created tab. |
| `workspaceId` | string | no | Destination workspace id. |
| `newWorkspace` | boolean | no | Move into a newly created workspace. |

**Returns:** `okText("Moved pane <id>.", {paneId, …echoed opts})`; on error the mapped code.

**Example**

```text
herdr_move_pane  paneId="w1:p3"  targetPane="w2:p1"  split="down"  ratio="0.5"
```

**Notes:** A move **needs a destination** — provide at least one of `tabId` /
`targetPane` / `workspaceId` / `newTab` / `newWorkspace`, or herdr returns an error.
The destination may be auto-created when `newTab`/`newWorkspace` is set.

---

### `herdr_swap_panes`

Swap two panes: by neighbor direction, or explicit source/target pane ids. Defaults to
the focused pane.

**Wraps:** `pane swap [--direction <d>] (--pane <id> | --current) [--source-pane <id>] [--target-pane <id>]`.

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `direction` | enum `left` \| `right` \| `up` \| `down` | no | Swap with the neighbor in this direction. |
| `paneId` | string | no | One pane to swap (default: the focused pane → `--current`). |
| `sourcePane` | string | no | Explicit source pane id. |
| `targetPane` | string | no | Explicit target pane id. |

**Returns:** `okText("Swapped panes (<source|focused> <-> <target|direction>).", {direction, paneId, sourcePane, targetPane})`;
on error the mapped code.

**Example**

```text
herdr_swap_panes  sourcePane="w1:p1"  targetPane="w1:p2"
```

**Notes:** Use either a neighbor `direction` (swaps the focused pane with its neighbor)
or explicit `sourcePane`/`targetPane`. With neither source nor target, the focused pane
is the source.
