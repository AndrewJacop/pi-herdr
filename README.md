# pi-herdr

[![npm version](https://img.shields.io/npm/v/@andrewjacop/pi-herdr.svg)](https://www.npmjs.com/package/@andrewjacop/pi-herdr)
[![license](https://img.shields.io/github/license/AndrewJacop/pi-herdr)](./LICENSE)
[![platform](https://img.shields.io/badge/platform-macOS%20%26%20Windows%20tested-blue)](#platform-support)

A [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) coding-agent
extension that turns pi into an **orchestrator over a fleet of visible AI agent
panes** running in [herdr](https://herdr.dev). Spawn another `pi`, `claude`,
`codex`, or `opencode` in its own terminal pane, send it a prompt, wait for it to
finish, and harvest its response — all from your pi session. Each spawned agent is
an independent CLI process you can watch, attach to, and intervene in while pi
coordinates them.

> **Complementary to [`pi-subagents`](https://www.npmjs.com/package/pi-subagents):**
> `pi-subagents` runs children **in-process** (fast, shared context). `pi-herdr`
> runs agents in **separate herdr panes** (visible, heterogeneous, resumable,
> directly attachable). They work well together.

---

## Platform support

**Tested on Windows and macOS.** The code is platform-aware (separate Windows/POSIX
launch presets; `herdr` spawned directly as a native binary) and is *expected* to work
on Linux too, though that has not been verified. herdr's own availability on each
platform follows [herdr.dev](https://herdr.dev). If you try Linux, please open an
issue with the result.

> **macOS — launch herdr from your terminal, not `brew services`.** A launchd-managed
> herdr server inherits macOS's minimal PATH (no `node`), and spawned `pi` agents die
> silently. See [Requirements → herdr](#2-herdr-the-workspace-manager).

---

## What is herdr?

[**herdr**](https://herdr.dev) is a **terminal workspace manager for AI coding
agents**. It runs multiple terminal panes/tabs/workspaces, each of which can host an
agent CLI (`pi`, `claude`, `codex`, …), and it tracks each pane's agent state
(`idle` / `working` / `blocked`). herdr exposes a local JSON-over-socket API and a
`herdr` CLI; **this extension speaks that CLI** so the pi LLM can spawn and drive
panes.

`pi-herdr` does **not** bundle herdr — herdr is a separate product you install and
run yourself (see below).

## Requirements

You need all of these before `pi-herdr` can do anything useful.

### 1. pi (the host agent)

```bash
npm install -g @earendil-works/pi-coding-agent
pi --version          # verify
```

pi needs at least one model + API key configured (run `pi` and use `/login`, or see
`pi --help`). **Spawned agents inherit this config**, so they can respond too.

### 2. herdr (the workspace manager)

Install herdr from **<https://herdr.dev>** (follow the instructions there for your
platform). Then verify it's on your `PATH` and start a session:

```bash
herdr --version       # verify, e.g. "herdr 0.7.5"
herdr status          # shows server + socket; "server: not running" until you launch it
herdr                 # launch the herdr workspace (starts its local server)
```

The `herdr` server must be running for `pi-herdr`'s tools to work — they talk to that
server. If herdr is missing or not running, every tool returns a clean
`HERDR_UNAVAILABLE` error instead of hanging.

> ℹ️ **Version compatibility.** `pi-herdr` probes `herdr --version` at session
> start and branches to match your herdr: it supports both the redesigned **0.7.5**
> API (`agent start` / `agent prompt`) and the older **0.7.3** API. If the `herdr`
> binary is missing you get a warning toast with the install link; the detected
> version shows in the footer, e.g. `herdr: 3 agents (1 working) (0.7.5)`.
>
> ⚠️ **Windows + herdr 0.7.5-preview.** herdr's `agent start --kind` is broken on
> Windows: it launches the agent via PowerShell `Start-Process -FilePath <kind>`,
> which can't run npm `.cmd` shims (`pi`, `claude`, …) — "%1 is not a valid Win32
> application". On Windows, `pi-herdr` instead runs the **bare** agent command via
> `pane run` (the pane's shell resolves the `.cmd` shim) and lets herdr
> **auto-detect** it; `agent prompt` / `get` / `read` / `rename` / `close` then
> work normally. macOS/Linux keep the `agent start --kind` path. See
> [Platform notes](#platform-notes).
>
> ⚠️ **herdr 0.8.2 (Windows).** herdr 0.8.2's agent-surface readiness validation
> is broken for pi panes: `agent prompt` and `agent send-keys` fail with
> `agent_not_ready` ("no longer the pane foreground process") even on
> interactive-ready panes, and `agent start --kind`-launched panes additionally
> lose state self-reporting. `pi-herdr` **v0.4.0+** works around both transparently:
> prompting falls back to pane-level submission (`pane send-text` + settled `Enter`),
> fallback-driven turns are driven by screen stability, and the Windows spawn path
> (bare `pane run`, which keeps self-report working) is unchanged. Verified by the
> full `/herdr-qa all` sweep: 43/43 tools PASS on 0.8.2 stable.

> ⚠️ **macOS — do not manage herdr with `brew services`.** `brew services` runs the
> herdr server under launchd, which gives it macOS's *minimal* PATH
> (`/usr/bin:/bin:/usr/sbin:/sbin`) with no `node`. Spawned `pi` is a
> `#!/usr/bin/env node` script, so it can't find `node` and the pane dies silently
> (~2s, no output). (`claude`/`codex` survive because they're standalone binaries.)
>
> Launch herdr from your terminal instead, so the server inherits your shell PATH:
>
> ```bash
> brew services stop --all 2>/dev/null; brew services stop herdr   # if you enabled it
> herdr                            # from your project dir; starts a server w/ your full PATH
> herdr status                     # confirm "server: running"
> ```
>
> herdr attaches to a *persistent* session, so you must stop the launchd server first
> — otherwise `herdr` just reattaches to the minimal-PATH one.
>
> If you must keep herdr in `brew services`, spawn agents with an absolute path **and**
> inject `PATH` via the `env` field of `herdr_start_agent` / `herdr_delegate`.

### 3. This extension

```bash
pi install npm:@andrewjacop/pi-herdr
```

That's it — every pi session (including agents you later spawn) will now load it.
Restart pi (or `/reload`) if a session was already running.

> **Quick test without installing:** `pi -ne -e ./src/index.ts` from a clone of
> this repo — `-ne` skips installed-extension discovery so only this local copy
> loads (great for end-to-end checks against a real herdr server).

## Install

### From npm (recommended)

```bash
pi install npm:@andrewjacop/pi-herdr
```

### From source / local dev

```bash
git clone https://github.com/AndrewJacop/pi-herdr.git
cd pi-herdr
npm install
pi install ./          # register the local checkout globally
```

---

## Quick start

With **herdr running** (you've launched `herdr` and `herdr status` shows the server
up), open **another** terminal and start pi in a project:

```bash
cd my-project
pi
```

Then just ask pi in natural language:

```
Use herdr_delegate to spawn a fresh pi agent and ask it to summarize README.md in 3 bullets.
```

You'll see a new pane appear in herdr, the spawned agent work, and pi return its
answer. While orchestrating, pi's footer shows the fleet, e.g. `herdr: 3 agents (1 working) (0.7.5)`.

---

## Examples

### Example 1 — One-shot delegation (simplest)

Hand a self-contained task to a fresh agent and get the answer back in one call.

> *Prompt:* `Use herdr_delegate to spawn a fresh pi and ask it: "what are 3 ways to reverse a list in Python?" Return its answer.`

**What happens:** `herdr_delegate` spawns a new pi pane, sends the prompt, waits for
the agent to finish, reads its reply, and returns it. The spawned pane is left alive
for follow-ups (pass `closeOnSuccess: true` to close it).

### Example 2 — Drive a pane step by step (watch a long task)

When you want to watch an agent work and control it directly:

> 1. `Use herdr_start_agent to launch a pi agent named "helper" in this project.`
> 2. `Use herdr_send_prompt to send "refactor utils.ts and run the tests" to "helper", with submit=true.`
> 3. `Use herdr_wait_agent to wait for "helper" to reach idle (timeoutMs 300000).`
> 4. `Use herdr_read_agent to read the last 80 lines from "helper" and summarize what it changed.`

**What happens:** You can switch to the `helper` pane in herdr at any time to watch
or even type into it. pi waits independently via the state machine.

### Example 3 — Parallel fan-out (do N things at once)

`herdr_delegate` calls run concurrently, so you can fan work out:

> *Prompt:* `In parallel, use herdr_delegate three times to spawn three pi agents — one to write tests for auth.ts, one for payment.ts, one for user.ts. Wait for all three, then give me a combined summary and any failures.`

**What happens:** Three panes spawn at once, each works its task concurrently, pi
collects all three results. (Pair with git worktrees — coming in a later tier — to
give each its own checkout.)

### Example 4 — Heterogeneous review (a different agent reviews pi's work)

> *Prompt:* `Use herdr_start_agent to launch a claude agent, then herdr_send_prompt it "review the diff in git diff main" and wait for its verdict. (agent: "claude")`

**What happens:** A `claude` pane boots, receives the diff, and returns a review.
Because each agent is a real CLI in its own pane, you can mix models/vendors freely.

> ⚠️ **Interrupting a stuck pane:** to send Ctrl-C to a runaway agent, use
> `herdr_send_keys` with `["ctrl+c"]` (set `agentScope: true` to target an agent
> rather than the raw pane).

---

## Tools

`pi-herdr` exposes the full herdr tool surface across five tiers. **Tier 1
(orchestration)** is the headline use case; tiers 2–5 cover layout, pane-sync,
git worktrees, and fleet introspection. Every tool that targets an existing pane
accepts `target` as a **pane id** (`w1:p3`), **agent name**, or **label**.

### Tier 1 — orchestration (spawn & drive agents)

| Tool | What it does |
| --- | --- |
| `herdr_start_agent` | Launch an agent (`pi`/`claude`/`codex`/`gemini`/`cursor`/… — ~20 kinds) in a herdr pane; returns pane id + state. |
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

### The other tiers (one line each)

- **Tier 2 — layout:** `herdr_split_pane`, `herdr_close_pane`, `herdr_list_panes`,
  `herdr_get_pane`, `herdr_resize_pane`, `herdr_zoom_pane`, `herdr_move_pane`,
  `herdr_swap_panes`; tab + workspace `create`/`list`/`get`/`focus`/`rename`/`close`.
- **Tier 3 — pane-sync:** `herdr_run_command`, `herdr_read_pane`, `herdr_wait_output`,
  `herdr_send_keys` ⚠️ (send logical keys like `ctrl+c` / `esc`).
- **Tier 4 — worktrees:** `herdr_worktree_create` / `open` / `list` / `remove` ⚠️.
- **Tier 5 — fleet introspection:** `herdr_api_snapshot`, `herdr_session_list`,
  `herdr_session_stop` ⚠️, `herdr_session_delete` ⚠️.

`herdr_start_agent` and `herdr_delegate` take an `AgentSpec`:

| Field | Default | Notes |
| --- | --- | --- |
| `agent` | `"pi"` | Agent kind, passed as `agent start --kind` on 0.7.5. herdr 0.7.5 ships ~20 kinds (`pi`, `claude`, `codex`, `gemini`, `cursor`, `devin`, `agy`, `cline`, `omp`, `mastracode`, `opencode`, `copilot`, `kimi`, `kiro`, `droid`, `amp`, `grok`, `hermes`, `kilo`, `qodercli`, `maki`); an unknown kind returns a `VALIDATION_ERROR` listing the kinds your herdr supports (the list is fetched live and cached per session, with this hardcoded fallback offline). The old `custom`/`argv` launch surface is gone — use `agentArgs` to load a local extension instead. |
| `agentArgs` | — | Extra flags appended to the agent CLI after launch, e.g. `["-ne","-e","./src/index.ts"]` to load a **local extension** instead of the installed copy (the dev / self-host loop). 0.7.5: after `--` in `agent start`; Windows pane-run: joined into the command line; legacy: extends the preset argv. *(v0.2.4)* |
| `cwd` | — | Working directory for the spawned agent. |
| `name` | `agent-<timestamp>` | Unique pane name. |

`herdr_delegate` also takes **`onBlocked`** (`"wait"` default, `"return"`): when the
spawned agent blocks on `ask_user`, `"wait"` holds the call open until a human
answers in the spawned pane, then returns the final answer; `"return"` returns
`{blocked, question, paneId}` so the orchestration session can relay the question
itself. See [orchestration tools](docs/tools/orchestration.md#herdr_delegate).

## How completion is detected (and why it's reliable)

herdr auto-detects a pi pane's state from its TUI. It reliably catches `idle → working`
but **sometimes misses `working → idle`**, which can leave a finished pane stuck on
`working` and hang a wait. `pi-herdr` solves this with **self-report**:

When pi runs inside a herdr pane, this extension pushes its real state to herdr on
lifecycle hooks — `agent_start → working`, `agent_settled → idle` — and on the
blocked EventBus channels. The current channel is `herdr:blocked`, emitted by
[`pi-ask-user`](https://www.npmjs.com/package/pi-ask-user) (v0.14+) when `ask_user`
waits/resumes **and** by `pi-subagents` for attention states; the legacy
`rpiv:ask-user:blocked` ([`@juicesharp/rpiv-ask-user-question`](https://www.npmjs.com/package/@juicesharp/rpiv-ask-user-question))
and `pi-cursor-sdk:ask-question:blocked` ([`pi-cursor-sdk`](https://github.com/fitchmultz/pi-cursor-sdk))
are kept for back-compat (`active: true → blocked`, `active: false → working` so
the turn resumes). pi-herdr is the bridge that turns `herdr:blocked` into a herdr
`pane report-agent --state blocked` — nothing else in JS consumes it, so without
this bridge blocked detection relies on herdr's native TUI-watching. herdr
renders that idle-after-working as `done` on builds that derive it;
`herdr_delegate` / `herdr_wait_agent` race the `idle` and `done` transition waits
(plus a polling fallback — see below). A global install
(`pi install npm:@andrewjacop/pi-herdr`) loads the extension into **every** pi —
including spawned ones — so all pi agents report reliably.

Completion is read from herdr's state events — never inferred from the
rendered `Working…` spinner (tool-call output replaces that spinner mid-work, which
would otherwise cause false "idle" reports). On herdr **0.7.5**, `herdr_delegate`
submits and waits in one atomic call (`agent prompt <target> <text> --wait`) and
`herdr_wait_agent` blocks on the repeatable `agent wait <target> --until <status>`
(`idle` / `done` / `blocked` can be raced in a single call); on **<0.7.5** these use
the legacy `agent send` + `wait agent-status` group. Both also **race a polling
`agent get` fallback** alongside the event wait: if the event is flaky or never
fires (e.g. herdr 0.7.3's `failed to decode pane get error`, or a `done`/`idle`
state herdr no longer derives), the poll still detects the settled state promptly —
instead of hanging on the event or timing out the budget. For an agent that can't
self-report (e.g. `claude`/`codex`), the poll catches the settled state too.

> **Tip:** You can always unstick a pane manually:
> `herdr pane report-agent <pane> --source manual --agent pi --state idle`.

## Configuration (environment variables)

| Variable | Default | Purpose |
| --- | --- | --- |
| `HERDR_BIN` | `herdr` (resolved via `PATH`/`PATHEXT`) | Override the herdr binary path. |
| `HERDR_PRESET_<NAME>` | built-in map | Add/override a preset as a JSON argv array, e.g. `HERDR_PRESET_GEMINI='["cmd","/c","gemini"]'`. |
| `PI_HERDR_NO_SELF_REPORT` | unset | Set to `1` to disable self-report in this pi. |

Built-in presets: `pi`, `claude`, `codex`, `omp` (opencode). On Windows they're
launched as `cmd /c <cli>`; elsewhere as the bare command.

## Platform notes

- **Windows:** the agent CLIs (`pi`, `claude`, …) are npm `.cmd` shims. `herdr` is
  a native executable spawned directly (no shell), so argv is passed literally.
  - On herdr **0.7.3** (legacy), agents launch via the `agent start … -- cmd /c <cmd>`
    form (the `cmd /c` wrapper is the launcher's job).
  - On herdr **0.7.5-preview**, `agent start --kind` can't launch them (PowerShell
    `Start-Process` rejects npm shims), so `pi-herdr` launches the **bare** command
    via `pane run <cmd>` (the pane's shell resolves the `.cmd` shim) and relies on
    herdr's auto-detection. The `cmd /c` wrapper is **not** used here — it nests a
    shell and breaks auto-detection.
- **macOS:** agents are spawned the same way (`shell:false`, literal argv). The only
  macOS gotcha is environmental: a herdr server started by `brew services` / launchd
  (or a GUI launch) inherits macOS's minimal PATH, so node-based agents like `pi`
  can't find `node`. Launch herdr from your terminal instead (see Requirements). If
  you can't, pass an absolute agent path and inject `PATH` via the tool's `env`.
- A known Git-Bash quirk mangles a literal `cmd /c` argument into `cmd C:/`. This
  only affects *typing* the command in a POSIX shell; `pi-herdr` spawns via Node with
  `shell: false`, so it is unaffected. (Don't drive herdr from bash in scripts.)

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
  index.ts               # entry; registers tools + footer status + self-report
  herdr.ts               # the one spawn module (envelope parse, timeouts, errors)
  launcher.ts            # AgentPreset -> platform argv
  config.ts              # binary + preset resolution (env + PATH)
  env.ts                 # shared types + unwrap/normalize/extractText helpers
  selfreport.ts          # push this pi's state to herdr (reliable completion)
  tools/orchestration.ts # Tier 1 tools + herdr_delegate (spawn/wait/send/read/…)
  tools/sync.ts          # Tier 3 pane-sync (split/run/read/wait_output/send_keys/close)
  tools/layout.ts        # Tier 2 layout (panes/tabs/workspaces)
  tools/worktrees.ts     # Tier 4 git worktrees
  tools/introspection.ts # Tier 5 snapshot/sessions
tests/
  smoke.mjs              # offline smoke (no herdr required)
  live.mjs, pong.mjs, delegate.mjs, selfreport.mjs, multi.mjs, stress.mjs
```

## Contributing

Contributions are welcome — especially macOS/Linux testing! Please open an issue
first to discuss substantial changes. See [CONTRIBUTING.md](./CONTRIBUTING.md).

## Limitations / roadmap

- **v0.2:** Tier 1 orchestration (`herdr_delegate` + the 10 atomic tools), macOS
  support, polling-fallback completion detection.
- **v0.2.5:** branched for herdr 0.7.5 (`agent prompt --wait`, `agent wait --until`,
  dynamic agent-kind validation), and added Tier 2 layout (panes/tabs/workspaces),
  Tier 3 pane-sync (`split` / `run` / `read` / `wait_output` / `send_keys` /
  `close`), Tier 4 git worktrees, and Tier 5 snapshot/sessions.
- **Tested on Windows and macOS** (see [Platform support](#platform-support)).
- Self-report is pi-only; heterogeneous (claude/codex) completion relies on herdr's
  auto-detect (also caught by the `agent get` polling fallback).

## License

[MIT](./LICENSE) © Andrew
