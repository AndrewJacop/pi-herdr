# pi-herdr docs

A [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) coding-agent
extension that turns pi into an **orchestrator over a fleet of visible AI agent
panes** running in [herdr](https://herdr.dev). It exposes pi's model a set of tools
that spawn, drive, wait for, and harvest other AI agents (`pi`, `claude`, `codex`,
`gemini`, …) each running in its own terminal pane — and also manage the full herdr
layout (panes, tabs, workspaces, git worktrees, named sessions). This is the
user-facing reference for **all 43 tools** the extension registers.

> **Not bundled here:** herdr itself. Install and run it from <https://herdr.dev>.

## Install

**Runtime prerequisites** (install separately — they are *not* npm deps):

```bash
npm install -g @earendil-works/pi-coding-agent   # pi, the host agent
# install + launch herdr from https://herdr.dev
herdr --version      # e.g. herdr 0.7.5
herdr                # launch the workspace (starts its local JSON server)
```

**The extension** (npm package `@andrewjacop/pi-herdr`):

```bash
pi install npm:@andrewjacop/pi-herdr
```

npm `peerDependencies`: `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`,
`typebox`. Requires Node `>=20`. Restart pi (or `/reload`) if a session was already
running. For local dev: `pi install ./` from a clone, or `pi -ne -e ./src/index.ts`.

## Quickstart

The core pattern is **spawn → list → drive → wait → harvest**. The simplest form is a
single one-shot call:

> Ask pi: *"Use `herdr_delegate` to spawn a fresh pi and ask it to summarize
> README.md in 3 bullets, then return its answer."*

```text
herdr_delegate
  prompt    = "Summarize README.md in 3 bullets."
  agent     = "pi"        # default
  timeoutMs = 120000      # default
```

`herdr_delegate` spawns a new pane, sends the prompt, waits for the agent to finish,
reads its reply, and returns it (leaving the pane alive unless `closeOnSuccess: true`).

For step-by-step control instead of one-shot delegation:

1. `herdr_start_agent` — launch a named agent pane.
2. `herdr_list_agents` / `herdr_get_agent` — see what's running.
3. `herdr_send_prompt` — drive it (submits with Enter by default).
4. `herdr_wait_agent` — block until `idle` / `done`.
5. `herdr_read_agent` — harvest the output.

See the [examples in the project README](../README.md#examples) for fan-out,
heterogeneous review, and long-running tasks.

## Tool catalog

Every tool that targets an existing pane accepts `target` as a **pane id**
(`w1:p3`), **agent name**, or **label**. 43 tools across five tiers:

| Tier | Surface | Tools | Count | Reference |
|------|---------|-------|------:|-----------|
| Tier 1 | Orchestration (spawn & drive agents) | start/prompt/read/wait/list/get/stop/rename/focus/explain agents + `delegate` | 11 | [tools/orchestration.md](tools/orchestration.md) |
| Tier 3 | Pane sync (raw terminal panes) | split / run / read / wait-output / send-keys / close | 6 | [tools/pane-sync.md](tools/pane-sync.md) |
| Tier 2 | Panes | list / get / resize / zoom / move / swap | 6 | [tools/panes.md](tools/panes.md) |
| Tier 2 | Tabs | list / create / get / focus / rename / close | 6 | [tools/tabs.md](tools/tabs.md) |
| Tier 2 | Workspaces | list / create / get / focus / rename / close | 6 | [tools/workspaces.md](tools/workspaces.md) |
| Tier 4 | Git worktrees | create / open / list / remove | 4 | [tools/worktrees.md](tools/worktrees.md) |
| Tier 5 | Introspection | api snapshot + session list/stop/delete | 4 | [tools/introspection.md](tools/introspection.md) |
| | | **Total** | **43** | |

> Pane create/destroy lives in Tier 3 ([pane-sync](tools/pane-sync.md)):
> `herdr_split_pane` and `herdr_close_pane`. The Tier 2 panes page covers the
> remaining pane operations.

## Conventions in 30 seconds

- **Uniform `Result<T>` envelope.** Every tool normalizes herdr output into
  `{ok:true,data}` or `{ok:false,error:{code,message,details?}}`, then maps it to a
  pi tool return. See [concepts › The `Result<T>` envelope](concepts.md#the-resultt-envelope).
- **Version-branched for herdr 0.7.5.** `isNewAgentApi(v)` selects the redesigned
  `agent start` / `agent prompt` / `agent wait` API on ≥0.7.5 vs the legacy
  (<0.7.5) commands. See [concepts › Version detection & branching](concepts.md#version-detection--branching).
- **Pane surface vs agent surface.** herdr 0.7.5 splits raw-process panes from AI
  agent panes; each tool targets one. See [concepts › Pane surface vs agent surface](concepts.md#pane-surface-vs-agent-surface).
- **Targeting.** Agents are targeted by **pane id** (`w1:p3`) or **name/label**
  (resolved via `agent get`). **Names are lowercase `[a-z0-9-_]`** — herdr rejects
  uppercase. See [concepts › Targets: pane id vs name](concepts.md#targets-pane-id-vs-name).
- **⚠️ destructive tools.** Anything that closes/terminates/kills/deletes is marked
  ⚠️ in its description and listed in [concepts › Destructive tools](concepts.md#destructive-tools-).
- **Timeouts & abort everywhere.** Every blocking herdr call takes a `timeoutMs`
  and honors an `AbortSignal`, resolving `TIMEOUT` instead of hanging. See
  [concepts › Timeouts & abort](concepts.md#timeouts--abort).
- **Agent kinds are live-validated.** `agent` is a free string validated against the
  live `herdr agent` kind list (cached per session, hardcoded fallback), else
  `VALIDATION_ERROR`. See [concepts › Agent kinds](concepts.md#agent-kinds).

For testing and extending the extension, see [development.md](development.md).

## Status

- Targets **herdr 0.7.5** (also supports legacy **0.7.3**).
- Extension **v0.2.5** (package `@andrewjacop/pi-herdr`).
- Offline smoke gate: **378 checks, all pass** (`npm test`; see [development.md](development.md)).
