# pi-herdr docs

A [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) coding-agent
extension that turns pi into an **orchestrator over a fleet of visible AI agent
panes** running in [herdr](https://herdr.dev). It exposes pi's model a small,
deliberate tool surface that spawns background agents (`pi`, `claude`, `codex`,
`gemini`, …) each running in its own terminal pane — plus a quartet of raw-pane
tools for logs, builds, and test suites. This is the user-facing reference for
the **9 tools** the extension registers (12 once the v0.6 tickets land).

> **Not bundled here:** herdr itself. Install and run it from <https://herdr.dev>.

## Install

**Runtime prerequisites** (install separately — they are *not* npm deps):

```bash
npm install -g @earendil-works/pi-coding-agent   # pi, the host agent
# install + launch herdr from https://herdr.dev
herdr --version      # e.g. herdr 0.9.0 — pi-herdr requires ≥ 0.9.0 (hard floor)
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

The core pattern is **spawn → wait → read** (and **steer** any time):

> Ask pi: *"Spawn a background agent to summarize README.md in 3 bullets and
> give me the result."*

```text
herdr_spawn_agent
  prompt = "Summarize README.md in 3 bullets."
  wait   = 180000       # optional: block until done (ms) — omit for background
```

`herdr_spawn_agent` splits a pane, launches the agent, submits the task prompt,
and returns `{name, paneId, status}` — address the agent by `name` afterwards.
With `wait` omitted you keep working; when you want the result:
`herdr_wait_agent(name, idle)` then `herdr_read_agent(name)`.

Step by step:

1. `herdr_spawn_agent` — launch a named agent pane with its task (background by default).
2. `herdr_list_agents` — see what's running and each agent's status.
3. `herdr_send_prompt` — steer an agent (follow-ups, corrections, answers).
4. `herdr_wait_agent` — block until `idle` / `blocked`.
5. `herdr_read_agent` — harvest the output.

Raw panes (a dev server, `heroku logs --tail`, a test suite): `herdr_run_command`
into an existing pane by id, `herdr_read_pane` / `herdr_wait_output` to watch it,
`herdr_send_keys` for key presses (incl. answering option-list questions).

See the [examples in the project README](../README.md#examples) for fan-out,
heterogeneous review, and the settings menu (`/subagents config`).

## The tool surface

| Tool | What it does |
|------|--------------|
| `herdr_spawn_agent` | The spawn entry point: pane + agent + task prompt in one call. Registry `type` or inline definition; gates (kill-switch, depth, parallel cap); `isolated` worktrees; queue over the cap. |
| `herdr_send_prompt` | Send/submit a prompt to an agent pane — steer it. |
| `herdr_wait_agent` | Block until a status (`idle`/`working`/`blocked`/`done`). |
| `herdr_read_agent` | Read an agent pane's output text. |
| `herdr_list_agents` | List running agents + statuses — the fleet's single introspection tool. |
| `herdr_run_command` | Run a shell command in a raw pane (text + Enter). |
| `herdr_read_pane` | Read a raw pane's terminal output. |
| `herdr_wait_output` | Block until a pane emits matching output (marker wait). |
| `herdr_send_keys` ⚠️ | Send logical key presses (`ctrl+c`, `esc`, `Enter`) — option-list answers, interrupts. |

Per-surface pages: [agent tools](tools/orchestration.md) ·
[pane-sync](tools/pane-sync.md) · [concepts](concepts.md).

> **Where did the other 34 tools go?** The v0.6 surface cut (wayfinder ticket
> 09): one surface, twelve tools eventually — layout, tab/workspace CRUD,
> worktree CRUD, introspection beyond `list_agents`, and the `herdr_delegate`
> composite are off the model surface. The machinery survives internally
> (`isolated` worktrees, the poll loop, kill-all's pane closes); the herdr UI
> remains the human's surface for layout. See
> [Upgrading in the project README](../README.md#upgrading-v05--v06).

## Settings — `/subagents config`

The `/subagents` command (bare, or `/subagents config`) opens the settings
menu: one flat list of `key = value (source: …)` rows plus a confirmed
**Kill all agents** action. Settings deep-merge from
`~/.pi/agent/herdr.json` (global) and `<project>/.pi/herdr.json` (project wins
per key — and per agent name for `models.agents`). Full table in the
[project README](../README.md#settings-subagents-config).

## Development

```bash
npm install
npm test            # offline suites (smoke + settings + spawn) — no herdr required
npm run typecheck   # tsc --noEmit
npm run test:live   # requires a running herdr session + a working model key
```

See [development](development.md) and the project README's Development section.
