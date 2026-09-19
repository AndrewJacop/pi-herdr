# Worktree tools

**Tier 4 — Git worktree helpers.** Spin up a parallel checkout of the current repo
(optionally on a new branch based off a ref) and open it as its own workspace, list the
linked checkouts, or tear one down.

> Count: **4 tools.** `--json` is always emitted so the envelope parser
> returns structured data. See [concepts](../concepts.md). Workspaces are managed in
> [workspaces](workspaces.md).

---

### `herdr_worktree_create`

Create a Git worktree (parallel checkout, optionally on a new branch based off a ref) and
open it as a workspace. Returns the worktree path, branch, and opened workspace id.

**Wraps:** `worktree create [--workspace <id>] [--cwd <repo>] [--branch <name>] [--base <ref>] [--path <dir>] [--label <s>] [--focus|--no-focus] --json`.

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `workspaceId` | string | no | Create the worktree in this workspace (default: current). |
| `cwd` | string | no | Source repo path to create the worktree from (default: cwd). |
| `branch` | string | no | Branch name for the new worktree (created from `base`). |
| `base` | string | no | Git ref to base the new branch on (e.g. `main`, a SHA). |
| `path` | string | no | Explicit checkout path for the worktree. |
| `label` | string | no | Label for the opened workspace. |
| `focus` | boolean | no | Focus the opened workspace (default herdr-determined → flag omitted). |

**Returns:** `okText("Created worktree[ on '<branch>'][ at <path>][ (workspace <id>)].", {path, branch, label, openWorkspaceId, …})`;
on error the mapped code (e.g. git failures surface as `VALIDATION_ERROR`).

**Example**

```text
herdr_worktree_create  branch="feat-auth"  base="main"
```

**Notes:** `branch` + `base` together create a new branch off `base` for the worktree.
Omitting `branch` checks out an existing ref. The worktree opens as a new workspace — pair
with `herdr_worktree_list` to see linked checkouts before removing any.

---

### `herdr_worktree_open`

Open an existing Git worktree as a workspace (by path or branch). Returns the worktree
path and opened workspace id.

**Wraps:** `worktree open [--workspace <id>] [--cwd <repo>] [--path <dir>] [--branch <name>] [--label <s>] [--focus|--no-focus] --json`.

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `workspaceId` | string | no | Open the worktree in this workspace (default: current). |
| `cwd` | string | no | Source repo path the worktree belongs to (default: cwd). |
| `path` | string | no | Checkout path of the existing worktree. |
| `branch` | string | no | Branch of the worktree to open. |
| `label` | string | no | Label for the opened workspace. |
| `focus` | boolean | no | Focus the opened workspace (default herdr-determined → flag omitted). |

**Returns:** `okText("Opened worktree[ '<branch>'][ at <path>][ (workspace <id>)].", {path, branch, label, openWorkspaceId, …})`;
on error the mapped code.

**Example**

```text
herdr_worktree_open  path="../pi-herdr-feat-auth"
```

**Notes:** Use this for a checkout that **already exists** on disk; use
`herdr_worktree_create` to make a new one. There is no `--base` (that's create-only).

---

### `herdr_worktree_list`

List Git worktree checkouts for a repo (the main checkout plus linked worktrees). Returns
each worktree's path, branch, label, and opened workspace id (if any).

**Wraps:** `worktree list [--workspace <id>] [--cwd <repo>] --json`.

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `workspaceId` | string | no | Resolve the repo from this workspace (default: current). |
| `cwd` | string | no | Source repo path to list worktrees for (default: cwd). |

**Returns:** `okText("<n> worktree(s):\n- <branch>[ @ <path>][ (open: <ws>)][ \"<label>\"]…" || "No worktrees.", {worktrees:[…]})`;
on error the mapped code.

**Example**

```text
herdr_worktree_list
```

**Notes:** Always list before `herdr_worktree_remove` to confirm which checkouts exist and
which are currently opened as workspaces.

---

### `herdr_worktree_remove`  ·  [Tier 4]  ·  ⚠️ destructive

⚠️ Removes a Git worktree checkout and **deletes its checkout directory** on disk. Set
`force` to remove a worktree with uncommitted changes.

**Wraps:** `worktree remove [--workspace <id>] [--force] --json`.

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `workspaceId` | string | no | Resolve the worktree to remove from this workspace (default: current). |
| `force` | boolean | no | Remove even with uncommitted changes / when not otherwise removable (default false). |

**Returns:** `okText("Removed worktree[ in <ws>][ (--force)].", {workspaceId, force, removed:true})`;
on error the mapped code (e.g. uncommitted changes without `force`).

**Example**

```text
herdr_worktree_remove  workspaceId="w3"  force=false
```

**Notes:** The worktree is resolved from the **current/`workspaceId` workspace**, not from
a path argument — so remove from the workspace that owns the worktree checkout. Prefer
`force:false` (the safe path); only set `force:true` when you accept losing uncommitted
work. List first with `herdr_worktree_list`.
