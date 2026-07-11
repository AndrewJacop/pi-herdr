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
