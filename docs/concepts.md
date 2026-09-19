# Concepts

Cross-cutting concepts that apply to **every** pi-herdr tool. The per-surface pages
([orchestration](tools/orchestration.md), [pane-sync](tools/pane-sync.md),
[panes](tools/panes.md), [tabs](tools/tabs.md), [workspaces](tools/workspaces.md),
[worktrees](tools/worktrees.md), [introspection](tools/introspection.md)) assume
these.

## The `Result<T>` envelope

Every interaction with the `herdr` CLI goes through one spawn module (`src/herdr.ts`)
that parses herdr's JSON envelope into a uniform [`Result<T>`](../src/env.ts):

```ts
type Result<T> =
  | { ok: true;  data: T }
  | { ok: false; error: { code: HerdrErrorCode; message: string; details?: unknown } };
```

`herdr()` **never throws** — every failure path resolves to `{ ok:false, error }`.
Each tool then maps that `Result<T>` to a pi tool return value (`ToolReturn`):

- **Success → `okText(text, details)`** — `{ content:[{type:"text",text}], details }`.
  The human-readable summary goes in `content`; the structured data (the normalized
  herdr payload) goes in `details`.
- **Failure → `fail(r)`** — `{ content:["Error (CODE): message"], details:{error}, isError:true }`.
  Setting `isError:true` flags the call for pi.
- **Partial (delegate only) → `partial(message, extra, isError=true)`** — when
  `herdr_delegate`'s agent times out or never starts, it still returns whatever
  partial output it could read, with the error in `details`.

### The `code` vocabulary

`HerdrErrorCode` is a fixed, normalized set surfaced to the model
([`src/env.ts`](../src/env.ts)):

| Code | Meaning |
|------|---------|
| `TIMEOUT` | A blocking call exceeded `timeoutMs` or was aborted. |
| `NOT_FOUND` | Target pane/agent/tab/workspace/session doesn't exist (herdr `not_found` / `no_such_agent` / `no_such_pane`). |
| `VALIDATION_ERROR` | Bad input — unknown agent kind, empty required field, mutually-exclusive params, or any unmapped herdr server error. |
| `AGENT_START_FAILED` | A spawned agent was not detected by herdr within budget (`agent_start_failed`). |
| `HERDR_UNAVAILABLE` | The `herdr` binary could not be resolved/spawned (ENOENT), or is missing from PATH. |
| `HERDR_TOO_OLD` | The detected herdr is below the ≥ 0.9.0 floor (or its version couldn't be determined) — the call is refused before it runs. |
| `PANE_GONE` | A split/create returned no pane/tab id, or a pane vanished mid-operation. |

The mapping is in [`mapCode()` in `herdr.ts`](../src/herdr.ts): `agent_start_failed →
AGENT_START_FAILED`; `*not_found*`/`no_such_agent`/`no_such_pane → NOT_FOUND`;
`*gone* → PANE_GONE`; `*timeout*`/`*timed_out* → TIMEOUT`; everything else →
`VALIDATION_ERROR`. herdr emits error envelopes on **stderr** (stdout empty,
non-zero exit); `herdr()` parses both stdout and stderr so codes map correctly rather
than surfacing raw JSON.

## Version floor: herdr ≥ 0.9.0

`pi-herdr` requires herdr **≥ 0.9.0** and probes `herdr --version` once per
session (cached; see [`src/herdr.ts`](../src/herdr.ts) — the probe and its
classification live next to the exec module, the pure compare logic in
[`src/version.ts`](../src/version.ts)). 0.9.0 is the release that fixed Windows
`agent start --kind`, which is what lets every platform share **one** launch
path — no version branches anywhere.

Below the floor there is no partial function: the gate inside `herdr()` itself
refuses every call with one clean `HERDR_TOO_OLD` error naming the upgrade
pointer (herdr.dev), the same style as `HERDR_UNAVAILABLE`. An unparseable
version is refused the same way (a hard floor doesn't guess); a missing binary
keeps its single natural `HERDR_UNAVAILABLE` instead of stacking two errors.
At/above the floor the probe keeps reporting for diagnostics: the footer shows
the detected version, e.g. `herdr: 3 agents (1 working) (0.9.0)`, and
`herdr: too old (0.8.2 < 0.9.0)` below it.

The commands the tools use (all current-surface, no legacy fallbacks):

- **`herdr_start_agent`** — `pane split --current --direction …` **then**
  `agent start <name> --kind <kind> --pane <id> [-- <agentArgs>]` (the pane must
  already exist). `agent_pane_busy` races the freshly-split shell's prompt, so
  the start retries briefly.
- **`herdr_send_prompt`** — `agent prompt <target> <text>` (submit) or
  `pane send-text <target> <text>` (text only).
- **`herdr_wait_agent`** — `agent wait <target> --until <s> [--until <s>…] --timeout <ms>`
  (`--until` is repeatable, so one call can race `idle`+`done`); `idle`/`done`
  always race a polling `agent get` fallback too.
- **`herdr_delegate`** — one atomic `agent prompt <target> <text> --wait --timeout <ms>`
  submits and waits for the turn to settle (`agent_prompt_stalled` falls back to
  the wait/poll dance).

## Pane surface vs agent surface

herdr 0.7.5 separates two surfaces:

- **Agent surface** — AI agent panes. Commands: `agent start` / `prompt` / `get` /
  `read` / `list` / `rename` / `focus` / `explain` / `wait` / `send-keys`. Used by
  the [orchestration](tools/orchestration.md) tools (Tier 1).
- **Pane surface** — raw terminal processes (logs, builds, test suites, shells).
  Commands: `pane split` / `run` / `read` / `wait-output` / `send-keys` / `close` /
  `list` / `get` / `resize` / `zoom` / `move` / `swap`, plus `tab …`, `workspace …`,
  `worktree …`, `api snapshot`, `session …`. Used by the [pane-sync](tools/pane-sync.md),
  [panes](tools/panes.md), [tabs](tools/tabs.md), [workspaces](tools/workspaces.md),
  [worktrees](tools/worktrees.md), and [introspection](tools/introspection.md) tools.

`herdr_send_keys` is the one tool that spans both: `agentScope:false` (default) →
`pane send-keys`; `agentScope:true` → `agent send-keys`.

## Targets: pane id vs name

A tool's `target` (or `paneId` / `tabId` / `workspaceId`) identifies a pane. For
agent-surface tools, `target` is flexible:

- a **pane id**, e.g. `w1:p3`;
- an **agent name** you set via `herdr_start_agent` / `herdr_rename_agent` / a
  delegate's `name`;
- a **label**.

Orchestration tools resolve a flexible `target` to a concrete pane id with `agent get`
before acting (e.g. `herdr_send_prompt`, `herdr_stop_agent`). Read-only tools
(`herdr_read_agent`, `herdr_get_agent`) pass `target` straight to herdr, which resolves
it itself.

**Names are lowercase `[a-z0-9-_]`.** herdr rejects uppercase characters in pane
names, so always name agents in lowercase. A name set via `herdr_start_agent` **is**
usable as a `target` by later calls.

## Destructive tools ⚠️

Tools that close/terminate/kill/delete carry a ⚠️ marker in their description (the
CONTRIBUTING convention) and in this wiki. There are **eight**:

- `herdr_stop_agent` — closes an agent pane (terminates the agent).
- `herdr_close_pane` — closes a raw pane by id (terminates whatever runs in it).
- `herdr_close_tab` — closes a tab (terminates every pane in it).
- `herdr_close_workspace` — closes a workspace (terminates every tab and pane in it).
- `herdr_send_keys` — sends logical key presses; `ctrl+c` interrupts a running process.
- `herdr_worktree_remove` — deletes the worktree's checkout directory on disk.
- `herdr_session_stop` — tears down a running named session's server + all its panes/tabs.
- `herdr_session_delete` — removes a stopped session's on-disk directory (permanent).

## Timeouts & abort

Every blocking `herdr()` call takes `timeoutMs` (default 60 s in the spawn module;
each tool sets its own — e.g. reads 15 s, snapshot 15 s, worktree create 60 s) and
honors an `AbortSignal` (the pi tool `signal`). On timeout or abort the child process
is killed and the call resolves `{ ok:false, error:{ code:"TIMEOUT", … } }` rather
than hanging — "Timeouts everywhere" per [`CONTRIBUTING.md`](../CONTRIBUTING.md).
Several tools also expose their own `timeoutMs` parameter (`herdr_wait_agent`,
`herdr_wait_output`, `herdr_delegate`).

## Agent kinds

`agent` (on `herdr_start_agent` / `herdr_delegate`) is a **free string**, default
`"pi"`. It is validated at execute time against the **live** kind list
emitted by `herdr agent` (the trailing `kinds: a|b|c` line), which is
[cached per session](../src/config.ts) with a hardcoded
[`AGENT_KINDS_FALLBACK`](../src/config.ts) (~21 kinds: `pi`, `claude`, `codex`,
`gemini`, `cursor`, `devin`, `agy`, `cline`, `omp`, `mastracode`, `opencode`,
`copilot`, `kimi`, `kiro`, `droid`, `amp`, `grok`, `hermes`, `kilo`, `qodercli`,
`maki`) when herdr is unavailable. An unknown kind returns a
`VALIDATION_ERROR` **listing the kinds your herdr supports**.

The old `agent:"custom"` + raw `argv` launch surface is gone. To load a **local
extension** instead of the installed one, pass `agentArgs` (e.g.
`["-ne","-e","./src/index.ts"]`) — they follow `--` in `agent start`, and herdr
resolves the kind to its CLI on its own side.
