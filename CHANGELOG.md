# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
