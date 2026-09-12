# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.0] - 2026-09-12

### Changed

- **Windows + herdr ≥0.9.0 now uses `agent start --kind`.** herdr 0.9.0 fixed the
  Windows `agent start --kind` launch (PowerShell `Start-Process` couldn't launch
  npm `.cmd` shims) and the flaky process-tree detection that made shim-launched
  agents intermittently drop out of the agents sidebar while still running
  (herdrdev/herdr #3032/#3205). On Windows with herdr ≥0.9.0, `herdr_start_agent`
  and `herdr_delegate` now register the agent with `agent start <name> --kind
  <kind> --pane <id> [-- <agentArgs>]` — proper named registration, lifecycle
  self-report, and native `--plan`/`-e` argument passthrough — identical to the
  macOS/Linux path. Windows herdr 0.7.5–0.8.x keeps the `pane run` + auto-detect
  fallback, and non-Windows platforms are unchanged. Validated e2e on Windows
  herdr 0.9.0: `--kind pi -- --plan` spawns named, stably-detected agents through
  a full plan-mode lifecycle (`tests/win-start.mjs` 13/13, plus a live `pi -e`
  self-host session spawning and driving a `--plan` agent).

### Fixed

- **Spawned panes landed in the herdr daemon's cwd, not the session's project.**
  When `cwd` was omitted, `herdr_start_agent`/`herdr_delegate`,
  `herdr_split_pane`, `herdr_create_tab`, and `herdr_create_workspace` let
  herdr default the new pane to the daemon process's cwd — which for a
  restored headless session is the user's home folder (e.g. an OPTOLINK
  session restored after reboot spawned agents in `C:\Users\Andrew`). All
  spawn surfaces now default `--cwd` to the pi process's own cwd, so panes
  land in the session root unless explicitly told otherwise.

## [0.4.0] - 2026-08-27

### Added

- **herdr 0.8.2 compatibility (Windows).** herdr 0.8.2's agent-surface readiness
  validation is broken for pi panes: `agent prompt` and `agent send-keys` fail with
  `agent_not_ready` ("no longer the pane foreground process") even on
  interactive-ready panes, and `agent start --kind`-launched panes additionally
  lose state self-reporting. Prompting now detects that error and transparently
  falls back to pane-level submission (`pane send-text` + 600 ms settle +
  `pane send-keys Enter` — the same bytes `agent prompt` sends), so
  `herdr_send_prompt` and `herdr_delegate` keep working. The fallback is
  self-gating: it only triggers on `agent_not_ready`, so healthy herdr versions
  are unaffected.
- **Degraded-mode turn driving in `herdr_delegate`.** On fallback-driven turns,
  lifecycle states are unreliable (stuck `idle`), so the delegate completes the
  turn by screen stability: 3 identical consecutive `agent read` polls after a
  10 s floor (a working TUI repaints continuously, so a stable screen means the
  turn settled). The driver samples `agent get` throughout, so an ask-user
  episode that resolves mid-turn still reports `details.wasBlocked: true`.
- **New `AGENT_NOT_READY` error code** in the normalized `HerdrErrorCode` set
  (mapped from herdr's `agent_not_ready`).
- **Validated multi-choice overlay semantics, documented everywhere relevant**
  (send_prompt guidelines, delegate blocked-relay instructions, docs):
  typed text never reaches a pi ask-user option list — bare `Enter` selects
  option 1 (preselected), `down`×n then `Enter` selects option n+1; typed text
  only lands in a focused freeform row. Answer freeform overlays with
  `herdr_send_prompt`, select options with `herdr_send_keys`.
- **`herdr_read_agent` now documents the alternate-screen scrollback limit**
  (in its tool description and docs): alternate-screen TUIs keep long answers
  off the host scrollback — ask the agent to write its response to a file and
  reply with the path, then read the file.

### Changed

- **Live test suite migrated to the herdr 0.7.5+/0.8.x CLI surface** — the
  legacy `agent start <name> --no-focus -- <argv>` form was removed upstream and
  all five affected tests now spawn through the current path. New shared helper
  `tests/_spawn.mjs` (split → `pane run` on Windows / `agent start --kind` on
  POSIX → detect → rename, plus `waitStatus`/`panePrompt`/overlay-answer
  helpers); `live.mjs` exercises the registered `herdr_start_agent` tool;
  `pong.mjs` drives `herdr_send_prompt` and polls the read; `selfreport.mjs`
  spawns with `-ne -e <local src>` (the global npm pi-herdr collides on tool
  names otherwise and crashes the spawned pi at boot); `blocked.mjs` answers
  overlays by key navigation with explicit `Red/Blue/Green` options and
  per-mode temp cwds.

### Verified

- Full offline gate: `typecheck` ✅, smoke 380/380 ✅.
- Full live suite on herdr 0.8.2 (stable, Windows): live 5/5, selfreport 4/4,
  pong 5/5, delegate 4/4, fallback 4/4, blocked 12/12, dev-load 11/11.
- Real-plugin QA sweep (`/herdr-qa all` in a fresh pi running the local
  extension): `FUNCTIONAL: pass`, `LIVE: pass`, `TOOLS: 43/43 pass`,
  `VERDICT: PASS`.

## [0.3.0] - 2026-08-11

### Added

- **`herdr_delegate` — `onBlocked` (`"wait"` \| `"return"`):** when a spawned agent
  blocks on `ask_user`, herdr 0.7.5's `agent prompt --wait` settles on `blocked` and
  returns ok — so previously the delegate treated the agent's *question text* as a
  successful answer and returned control to the orchestrator. The delegate now
  re-reads `agent get` after the turn settles and branches: `"wait"` (default) holds
  the call open with **no time bound** until a human answers in the spawned pane,
  then returns the final answer; `"return"` returns `{blocked, question, paneId}`
  immediately (`isError`, pane kept alive) for the orchestration session to relay.
  `timeoutMs` does not bound the `"wait"` phase.

### Fixed

- **Self-report now bridges `herdr:blocked`:** the current `pi-ask-user` (v0.14+)
  and `pi-subagents` emit `herdr:blocked`, but self-report only listened on the stale
  `rpiv:ask-user:blocked` channel — so blocked reporting silently relied on herdr's
  native TUI detection. Self-report now consumes `herdr:blocked` (the legacy
  `rpiv:ask-user:blocked` and `pi-cursor-sdk:ask-question:blocked` channels are kept
  for back-compat), making pi-herdr the single JS bridge that reports `blocked` to
  herdr.

### Tests

- `tests/blocked.mjs` (live): exercises both `onBlocked` modes against real spawned
  `pi` sessions (return-and-relay, and wait-then-inject).
- `tests/dev-load.mjs` (live): asserts `pi -ne -e <local pi-herdr> -e <pi-ask-user>`
  boots without conflicting with the globally-installed copy. Both wired into
  `test:live`; offline smoke gate grows to **380 checks**.

## [0.2.5] - 2026-08-02

The "full herdr 0.7.5 surface" release. The extension now wraps **43 tools** across
five tiers (was 11, orchestration-only) — pane/tab/workspace CRUD, raw pane sync,
git worktrees, and live introspection — plus bug fixes and refactors on the
redesigned 0.7.5 `agent` API. Offline smoke gate grows to **378 checks**; a full
**live sweep of all 43 tools** passed against herdr 0.7.5-preview.

### Added

- **Tier 3 — pane-sync (6 tools):** `herdr_split_pane`, `herdr_run_command`,
  `herdr_read_pane`, `herdr_wait_output`, `herdr_send_keys` (⚠️), `herdr_close_pane`
  (⚠️) — the raw-process surface 0.7.5 splits out from agents (use case: run a
  command in a pane and read its output on demand). Always emits `--timeout` so
  `wait_output` never hangs.
- **Tier 2 — layout (18 tools):** panes (`list`/`get`/`resize`/`zoom`/`move`/`swap`),
  tabs (`list`/`create`/`get`/`focus`/`rename`/`close` ⚠️), workspaces
  (`list`/`create`/`get`/`focus`/`rename`/`close` ⚠️). Pane `split`/`close` reuse
  Tier 3.
- **Tier 4 — git worktrees (4 tools):** `herdr_worktree_create`,
  `herdr_worktree_open`, `herdr_worktree_list`, `herdr_worktree_remove` (⚠️).
- **Tier 5 — introspection (4 tools):** `herdr_api_snapshot`, `herdr_session_list`,
  `herdr_session_stop` (⚠️), `herdr_session_delete` (⚠️). Interactive
  `session attach` is excluded.
- **User-facing wiki** under `docs/` — landing page, concepts (envelope, version
  branching, pane-vs-agent surface, targeting/naming, destructive tools),
  per-surface references for all 43 tools, and a development/testing guide.
- `tests/smoke.mjs` extended with argv-builder, normalizer, destructive-label, and
  registration-count assertions (84 → 378 checks).

### Fixed

- **`herdr_wait_agent` on herdr 0.7.5.** The removed `wait agent-status` group
  broke waits for `working`/`blocked`/`unknown` (only `idle`/`done` survived via
  the polling fallback). The new API now emits
  `agent wait <target> --until <s> [--until …] --timeout <ms>` (`idle`/`done` still
  race the `agent get` fallback); legacy keeps `wait agent-status`.

### Changed

- **`herdr_delegate` is atomic on 0.7.5.** Submit+wait is now a single
  `agent prompt <target> <text> --wait --timeout <ms>`; `agent_prompt_stalled`
  falls back to wait/poll instead of hanging, and the turn is re-sent up to 3× if
  it never starts. Legacy send → wait dance unchanged.
- **Dropped the dead `custom`/`argv` launch surface.** `agent:"custom"`+`argv` is
  rejected on 0.7.5; removed from the LLM schema. `agent` is now a free string
  **validated against the live `herdr agent` kind list** (cached per session,
  hardcoded fallback), else `VALIDATION_ERROR`. Use `agentArgs` to load a local
  extension.

### Docs

- README refreshed for the 0.7.5 command surface (real ~20 agent kinds,
  completion detection via `agent prompt --wait` / `agent wait --until`, the five
  shipped tiers, corrected stale examples).

## [0.2.4] - 2026-08-02

### Added

- **`agentArgs` on `herdr_start_agent` / `herdr_delegate`.** Pass extra flags to
  the spawned agent CLI — most importantly
  `agentArgs: ["-ne","-e","./src/index.ts"]` to launch a `pi` that loads a
  **local extension** instead of the installed copy (the dev / self-host loop, and
  the basis for the v0.2.5 self-driving task pipeline). Threaded through all three
  launch paths:
  - herdr ≥0.7.5 (macOS/Linux): `agent start <name> --kind <kind> --pane <id> --
    <agentArgs>` (herdr's documented native-args form — verified against herdr's
    `agent_start` source + official CLI reference, platform-independent).
  - herdr ≥0.7.5 (Windows): joined into the `pane run` command line (the
    auto-detect launch path, since `agent start --kind` is Windows-broken in the
    0.7.5 preview).
  - legacy `<0.7.5`: appended to the preset argv after `--`.
  Verified end-to-end on Windows: a tool-driven `herdr_start_agent` spawn with
  `agentArgs` loaded the local `./src` (boot showed `[Extensions] src`).
- `tests/smoke.mjs` asserts `agentArgs` is exposed on both tool schemas.

## [0.2.3] - 2026-07-29

### Fixed

- **Windows + herdr 0.7.5-preview: `herdr_start_agent` / `herdr_delegate` now
  spawn.** herdr 0.7.5-preview's `agent start --kind` is broken on Windows: it
  launches the agent via PowerShell `Start-Process -FilePath <kind>`, which can't
  run npm `.cmd` shims (`pi`, `claude`, …) — "%1 is not a valid Win32 application"
  (with no agent args it first surfaces as an empty `-ArgumentList`). On Windows
  the launch now splits a pane, runs the **bare** agent command via `pane run` (the
  pane's shell resolves the `.cmd` shim via PATHEXT), waits for herdr to
  auto-detect the agent, then names it. `agent prompt` / `get` / `read` / `rename`
  / `close` then work on the auto-detected pane as usual.
  - The bare command is used (e.g. `pi`), **not** the `cmd /c` wrapper — the
    wrapper nests a shell and herdr's auto-detection then sees `cmd`, not the
    agent.
  - macOS/Linux keep the working `agent start --kind` path: a
    `process.platform === "win32"` guard sits in front of it; the non-Windows
    code is unchanged.
  - The stale "Windows still ships 0.7.3" assumption in the comments was also
    corrected — Windows now runs the 0.7.5 preview channel.

### Added

- `tests/win-start.mjs` + `npm run test:win` — Windows-only live test that loads
  the edited `src` via jiti and exercises every orchestration tool against a pane
  created by the fixed launch path. Self-skips on non-Windows (safe inside
  `test:live` on macOS).

## [0.2.2] - 2026-07-29

### Fixed

- **herdr 0.7.5: `herdr_start_agent` / `herdr_delegate` now actually spawn.**
  0.2.1's new path splits a pane then calls `agent start`, but herdr returns
  `agent_pane_busy` while the freshly-split shell is still reaching its prompt
  (it fails fast instead of waiting), so spawning always failed on 0.7.5. The
  start now retries `agent start` briefly (≤6s) on `agent_pane_busy`.
- **herdr 0.7.5 error envelopes (emitted on stderr) are now parsed.** herdr 0.7.5
  writes error JSON to stderr (stdout empty, non-zero exit); the helper only
  parsed stdout, so every error collapsed to a generic
  `VALIDATION_ERROR: herdr error: {json}` with no usable code. Errors now map to
  their real code/message (e.g. `agent_pane_busy`, `protocol_mismatch`) — which
  is also what lets the start retry recognize `agent_pane_busy`.
- **herdr 0.7.5: `herdr_send_prompt` / `herdr_delegate` send step.** 0.7.5 removed
  `agent send` (replaced by `agent prompt`, which types + submits in one call). The
  send step now branches by version: 0.7.5 uses `agent prompt` (or `pane send-text`
  for type-only); legacy keeps `agent send` + `pane send-keys Enter`.

## [0.2.1] - 2026-07-29

### Added

- **Self-report `blocked` while a questionnaire awaits input.** Subscribe to
  `rpiv:ask-user:blocked` (`@juicesharp/rpiv-ask-user-question`) and
  `pi-cursor-sdk:ask-question:blocked` (`pi-cursor-sdk`), mapping
  `{ active: true }` → `blocked`, `{ active: false }` → `working` (turn still
  in progress). Requires a pi host that loads this extension plus the matching
  producer package.
- **Proactive herdr detection at session start.** The version probe now runs
  eagerly on `session_start` (`startup`/`reload`) instead of lazily on the first
  agent-start call, so an install/upgrade or a missing herdr is noticed
  immediately. If herdr is absent (or its version can't be parsed) a warning
  toast points to the install instructions (`herdr.dev` / `brew install herdr`);
  the footer always shows the detected version, e.g.
  `herdr: 3 agents (1 working) (0.7.5)`.

### Fixed

- **herdr 0.7.5 compatibility for `herdr_start_agent` / `herdr_delegate` (#2).**
  herdr 0.7.5 redesigned `agent start`: it no longer creates a pane or accepts
  `--cwd/--split/--tab/--workspace/--env/--focus`, and now requires `--kind`/
  `--pane` on an *existing* pane. The old code always passed `--focus`/
  `--no-focus`, so both tools unconditionally failed on 0.7.5 with
  `unknown option: --focus` (exit 2). The extension now detects the herdr version
  once and branches:
  - **legacy (`<0.7.5`)** — incl. the Windows beta — keeps the original
    one-call `agent start` (unchanged).
  - **new (`>=0.7.5`)** — splits a pane (`pane split --current --direction …`),
    then `agent start <name> --kind <preset> --pane <id>`. Custom `argv:` returns
    a clear `VALIDATION_ERROR` (0.7.5 has no raw-argv path).
  Both tools route through one shared, version-branched helper.

## [0.2.0] - 2026-07-13

### Added

- **macOS support (verified).** Launch herdr from your terminal, not `brew services`
  — a launchd-managed herdr server inherits macOS's minimal PATH (no `node`), so
  spawned `pi` agents (a `#!/usr/bin/env node` script) die silently. See README →
  Platform support / Requirements. (`claude`/`codex` are standalone binaries and are
  unaffected.)
- **`env` param on `herdr_delegate`** (parity with `herdr_start_agent`): pass extra
  environment variables (e.g. `PATH`) to the spawned agent — the recovery path on a
  minimal-PATH herdr server.
- **Polling fallback for completion detection.** `herdr_delegate` /
  `herdr_wait_agent` now race herdr's `wait agent-status` event against an
  `agent get` poll, so completion is detected reliably even when `wait agent-status`
  is flaky (e.g. herdr 0.7.3's `failed to decode pane get error`) or a state isn't
  derived (herdr ≥0.7.3 no longer renders `done`). Completion no longer depends on
  the event command firing, nor on timing out the budget.
- `tests/fallback.mjs` (live) validating the fallback; platform-aware test suite via
  a shared `tests/_platform.mjs` helper (no more hardcoded Windows `cmd /c` argv or
  `D:/...` paths).

### Changed

- README: platform badge + Platform support now "macOS & Windows tested"; macOS
  Requirements callout and Platform notes bullet; "How completion is detected"
  updated to describe the polling fallback.

## [0.1.1] - 2026-07-12

### Changed

- Renamed the npm package to the scoped **`@andrewjacop/pi-herdr`** (the
  unscoped `pi-herdr` is retired). Install with
  `pi install npm:@andrewjacop/pi-herdr`.
- README: comprehensive onboarding (what herdr is, install steps for each
  prerequisite, platform-support callout, worked examples) and fixed the license
  badge (now sourced from the GitHub LICENSE instead of the retired npm name).

No functional changes since 0.1.0.

## [0.1.0] - 2026-07-12

### Added

- **Tier 1 orchestration tools** for driving herdr agent panes from the pi LLM:
  `herdr_start_agent`, `herdr_send_prompt`, `herdr_read_agent`, `herdr_wait_agent`,
  `herdr_list_agents`, `herdr_get_agent`, `herdr_stop_agent` (destructive),
  `herdr_rename_agent`, `herdr_focus_agent`, `herdr_explain_agent`.
- **`herdr_delegate`** — composite one-shot: spawn → send → wait → harvest response.
- **Self-report** (`src/selfreport.ts`): a pi running inside a herdr pane pushes its
  real `working`/`idle` state to herdr so `agent_status` is reliable (fixes herdr's
  occasional `working → idle` miss that left finished panes stuck).
- Platform-aware launcher: Windows `cmd /c` wrapper for npm-shim agent CLIs
  (`pi`, `claude`, `codex`, `opencode`); `herdr` spawned directly as a native binary.
- Uniform `Result<T>` envelope and `HerdrErrorCode` set across all tools, with
  timeouts, abort support, and `HERDR_UNAVAILABLE` handling when herdr is missing.
- Configurability via environment: `HERDR_BIN`, `HERDR_PRESET_*`, `PI_HERDR_NO_SELF_REPORT`.
- Test suite: offline smoke (extension load, tools, argv, unavailable, timeout,
  envelope/error parsing), live integration, and parallel multi-agent stress tests
  with on-disk artifact verification.

[0.1.0]: https://github.com/AndrewJacop/pi-herdr/releases/tag/v0.1.0
[0.1.1]: https://github.com/AndrewJacop/pi-herdr/releases/tag/v0.1.1
[0.2.0]: https://github.com/AndrewJacop/pi-herdr/releases/tag/v0.2.0
[0.2.1]: https://github.com/AndrewJacop/pi-herdr/releases/tag/v0.2.1
[0.2.2]: https://github.com/AndrewJacop/pi-herdr/releases/tag/v0.2.2
