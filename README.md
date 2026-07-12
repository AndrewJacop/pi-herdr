# pi-herdr

[![npm version](https://img.shields.io/npm/v/pi-herdr.svg)](https://www.npmjs.com/package/pi-herdr)
[![license](https://img.shields.io/npm/l/pi-herdr.svg)](./LICENSE)

A [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) coding-agent
extension that exposes [herdr](https://herdr.dev) — a terminal workspace manager
for AI coding agents — to the LLM as a curated set of tools.

With `pi-herdr`, pi becomes an **orchestrator over a fleet of visible agent panes**:
spawn another `pi`, `claude`, `codex`, or `opencode` in a real herdr pane, send it a
prompt, wait for it to finish, and harvest its response. Each spawned agent runs as
an independent CLI process in its own terminal, so you can watch, attach, and
intervene while pi coordinates them.

> **Complementary to [`pi-subagents`](https://www.npmjs.com/package/pi-subagents).**
> `pi-subagents` runs children **in-process** (fast, shared context).
> `pi-herdr` runs agents in **separate herdr panes** (visible, heterogeneous,
> resumable, directly attachable). Use both together.

## Requirements

| Requirement | Why |
|---|---|
| [`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) (pi) | The host agent. |
| [herdr](https://herdr.dev) on your `PATH` | The terminal workspace manager whose API this extension drives. |
| A running herdr session | Tools talk to herdr's local server. Launch `herdr` before orchestrating. |
| A working model + API key (for spawned agents) | Spawned agents inherit your pi config; they need a model to respond. |

Works on **Windows, macOS, and Linux**. All platform differences (the Windows
`cmd /c` wrapper for npm-shim CLIs; `herdr` spawned directly as a native binary)
are handled internally.

## Install

### From npm (recommended)

```bash
pi install npm:pi-herdr
```

That's it — every pi session (including agents you spawn) will load it.

### From source / local dev

```bash
git clone https://github.com/YOUR-GITHUB-USERNAME/pi-herdr.git
cd pi-herdr
npm install
pi install ./            # register locally
# or, for a quick test without installing:
pi -e ./src/index.ts
```

## Quick start

Launch herdr (so its server is up), then in a pi session:

```
Use herdr_delegate to spawn a fresh pi agent and ask it to summarize this file in 3 bullets.
```

Or drive a pane step by step:

```
Use herdr_start_agent to launch a pi agent named "helper", then herdr_send_prompt it
"list 3 colors", then herdr_wait_agent for idle, then herdr_read_agent and show me its answer.
```

While orchestrating, the pi footer shows the fleet, e.g. `herdr: 3 agents (1 working)`.

## Tools

All Tier 1 (orchestration) tools are included. Every tool that targets an existing
pane accepts `target` as a **pane id** (`w1:p3`), **agent name**, or **label**.

| Tool | What it does |
|---|---|
| `herdr_start_agent` | Launch an agent (`pi`/`claude`/`codex`/`omp`/`custom`) in a herdr pane; returns pane id + state. |
| `herdr_send_prompt` | Send a prompt to a pane; submits with Enter by default. |
| `herdr_read_agent` | Read recent/visible output text from a pane. |
| `herdr_wait_agent` | Block until a pane reaches `idle`/`working`/`blocked`/`done`. |
| `herdr_list_agents` | List all running agents with their status. |
| `herdr_get_agent` | Get one agent's details. |
| `herdr_stop_agent` ⚠️ | **Destructive.** Close an agent's pane (terminates it). |
| `herdr_rename_agent` | Rename (or clear the name of) a pane. |
| `herdr_focus_agent` | Focus a pane in the herdr UI. |
| `herdr_explain_agent` | Natural-language explanation of what a pane is/does. |
| `herdr_delegate` | **Composite one-shot:** spawn → send → wait → harvest response. |

`herdr_start_agent` and `herdr_delegate` take an `AgentSpec`:

| Field | Default | Notes |
|---|---|---|
| `agent` | `"pi"` | One of `pi`, `claude`, `codex`, `omp` (opencode), `custom`. |
| `argv` | — | Explicit launch argv; overrides the preset (required for `custom`). |
| `cwd` | — | Working directory for the spawned agent. |
| `name` | `agent-<timestamp>` | Unique pane name. |

### Parallel fan-out

`herdr_delegate` calls run concurrently — call several in parallel to fan work out:

```
In parallel, use herdr_delegate three times to spawn three pi agents, each implementing
one of the tasks in TASKS.md in its own worktree, then summarize their results.
```

## How completion is detected (and why it's reliable)

herdr auto-detects a pi pane's state from its TUI. It reliably catches `idle → working`
but **sometimes misses `working → idle`**, which can leave a finished pane stuck on
`working` and hang a wait. `pi-herdr` solves this with **self-report**:

When pi runs inside a herdr pane, this extension pushes its real state to herdr on
lifecycle hooks — `agent_start → working`, `agent_settled → idle`. herdr renders that
idle-after-working as `done`, which `herdr_delegate` / `herdr_wait_agent` detect by
racing the `idle` and `done` transition waits. Because a global install loads the
extension into **every** pi (including spawned ones), all pi agents report reliably.

Completion is read **only** from herdr's state events — never inferred from the
rendered `Working…` spinner (tool-call output replaces that spinner, which would
otherwise cause false "idle" reports mid-work). For an agent that can't self-report
(e.g. `claude`/`codex`, which don't load pi extensions) and where herdr misses the
transition, the wait times out and the delegate returns whatever partial output it
could read.

> **Tip:** For a heterogeneous fleet, you can still unstick any pane manually:
> `herdr pane report-agent <pane> --source manual --agent pi --state idle`.

## Configuration (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `HERDR_BIN` | `herdr` (resolved via `PATH`/`PATHEXT`) | Override the herdr binary path. |
| `HERDR_PRESET_<NAME>` | built-in map | Add/override a preset as a JSON argv array, e.g. `HERDR_PRESET_GEMINI='["cmd","/c","gemini"]'`. |
| `PI_HERDR_NO_SELF_REPORT` | unset | Set to `1` to disable self-report in this pi. |

Built-in presets: `pi`, `claude`, `codex`, `omp` (opencode). On Windows they're
launched as `cmd /c <cli>`; elsewhere as the bare command.

## Platform notes

- **Windows:** the agent CLIs (`pi`, `claude`, …) are npm `.cmd` shims and are
  launched through a `cmd /c` wrapper automatically. `herdr` is a native executable
  and is spawned directly (no shell), so argv is passed literally.
- A known Git-Bash quirk mangles a literal `cmd /c` argument into `cmd C:/`. This
  only affects typing the command in a POSIX shell; `pi-herdr` spawns via Node with
  `shell: false`, so it is unaffected. (Avoid driving herdr from bash in scripts.)

## Development

```bash
npm install
npm test                 # offline smoke (no herdr required)
npm run typecheck        # tsc --noEmit
npm run test:live        # requires a running herdr session
npm run test:multi       # 3 parallel agents, multi-step, artifact-verified
npm run test:stress      # 5 parallel agents, heavy multi-tool, artifact-verified
```

The extension is TypeScript loaded via jiti — **no build step**. Edit `src/` and
`/reload` (or restart pi).

### Project layout

```
src/
  index.ts              # entry; registers tools + footer status + self-report
  herdr.ts              # the one spawn module (envelope parse, timeouts, errors)
  launcher.ts           # AgentPreset -> platform argv
  config.ts             # binary + preset resolution (env + PATH)
  env.ts                # shared types + unwrap/normalize/extractText helpers
  selfreport.ts         # push this pi's state to herdr (reliable completion)
  tools/orchestration.ts# Tier 1 tools + herdr_delegate
tests/
  smoke.mjs             # offline (50 checks)
  live.mjs, pong.mjs, delegate.mjs, selfreport.mjs, multi.mjs, stress.mjs
```

## Contributing

Contributions are welcome! Please open an issue first to discuss substantial changes.

1. Fork & branch from `main`.
2. `npm test` and `npm run typecheck` must pass; add tests for new behavior.
3. For tools that touch a running herdr, exercise them via the `tests/*` harnesses.
4. Keep the cross-cutting contract: uniform `Result<T>`, `HerdrErrorCode`, and `target` model.

## Limitations / roadmap

- **v0.1 (this release):** Tier 1 orchestration (`herdr_delegate` + the 10 atomic tools).
- **Planned:** Tier 3 sync (`wait_output`, `send_keys`, `run_command`, `notify`),
  Tier 2 layout (panes/tabs/workspaces), Tier 4 git worktrees, Tier 5 sessions/snapshot.
- Self-report is pi-only; heterogeneous (claude/codex) completion relies on herdr's
  auto-detect.

## License

[MIT](./LICENSE) © Andrew
