# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.1.0]: https://github.com/YOUR-GITHUB-USERNAME/pi-herdr/releases/tag/v0.1.0
