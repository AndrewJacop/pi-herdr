# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Self-report `blocked` while `@juicesharp/rpiv-ask-user-question` awaits input:
  subscribe to `rpiv:ask-user:blocked` and map `{ active: true }` → `blocked`,
  `{ active: false }` → `working` (turn still in progress). Requires a pi host
  that loads both this extension and the ask-user package.

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
