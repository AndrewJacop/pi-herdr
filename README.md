# pi-herdr

A [pi coding-agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
extension that exposes [herdr](https://herdr.dev) (a terminal workspace manager for
AI coding agents) to the LLM as a set of curated custom tools.

With `pi-herdr`, pi becomes an orchestrator over a fleet of **visible** agent panes
running in herdr: spawn another `pi`/`claude`/`codex`/… in a real terminal pane,
send it a prompt, wait for it to finish using herdr's agent state machine
(`idle`/`working`/`blocked`), and harvest its response.

It is **complementary** to `pi-subagents` (which runs children in-process). Here
each agent runs in its own independent CLI process the user can watch and attach to.

## Requirements

- `pi` (`@earendil-works/pi-coding-agent`) — the host.
- `herdr` on your `PATH` (native binary on Windows; `herdr` on macOS/Linux).

## Install (local dev)

```bash
npm install        # dev deps for type-checking
pi -e ./src/index.ts
```

Or drop into `~/.pi/agent/extensions/pi-herdr/` for auto-discovery.

## Configuration (env)

| Var | Default | Purpose |
|---|---|---|
| `HERDR_BIN` | `herdr` (resolved via `PATH`/`PATHEXT`) | Override the herdr binary path |
| `HERDR_PRESET_<NAME>` | built-in map | Override/add an agent preset as a JSON argv array, e.g. `HERDR_PRESET_GEMINI='["cmd","/c","gemini"]'` |

Built-in presets: `pi`, `claude`, `codex`, `omp` (opencode). Use `agent: "custom"`
with an explicit `argv` for anything else.

## Tools (Tier 1 — orchestration)

`herdr_start_agent`, `herdr_send_prompt`, `herdr_read_agent`, `herdr_wait_agent`,
`herdr_list_agents`, `herdr_get_agent`, `herdr_stop_agent` ⚠️, `herdr_rename_agent`,
`herdr_focus_agent`, `herdr_explain_agent`, and the composite `herdr_delegate`.

## Platform notes

On Windows the agent CLIs (`pi`, `claude`, …) are npm `.cmd` shims and must be
launched through a `cmd /c` wrapper — the extension does this automatically.
`herdr` itself is a native executable and is spawned directly.

## Reliable completion detection (why spawned agents don't get stuck)

herdr auto-detects a pi pane's state from its TUI: it reliably catches
`idle → working` but sometimes **misses `working → idle`**, leaving a finished
pane stuck on `working` (so `herdr_wait_agent`/`herdr_delegate` would hang).
This extension handles that two ways:

1. **Self-report (primary).** When pi itself runs inside a herdr pane
   (`HERDR_PANE_ID` + `HERDR_ENV=1`), the extension pushes pi's real state to
   herdr via `pane report-agent` on lifecycle hooks (`agent_start → working`,
   `agent_settled → idle`). So any spawned pi that loads this extension reports
   `working → done` reliably. Disable with `PI_HERDR_NO_SELF_REPORT=1`.
2. **Output-based fallback.** `herdr_delegate` and `herdr_wait_agent` (for
   `idle`/`done`) additionally poll the pane's rendered content and treat the
   disappearance of pi's `Working…` spinner as completion, then self-heal
   herdr's stale state. This covers agents that can't self-report (e.g. claude,
   codex, or pi without the extension).

For the self-report path to protect *spawned* pi agents, install pi-herdr where
they load it (globally, or pass `-e path/to/src/index.ts` when spawning).
