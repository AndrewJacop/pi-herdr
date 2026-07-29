# Contributing to pi-herdr

Thanks for considering a contribution! This extension turns pi into an orchestrator
over herdr agent panes, so most changes touch either the spawn/envelope layer
(`src/herdr.ts`, `src/launcher.ts`, `src/config.ts`) or the tool surface
(`src/tools/*.ts`).

## Setup

```bash
git clone <repo>
cd pi-herdr
npm install        # dev deps (typebox, pi host types, typescript, jiti)
```

You do **not** need a build step — pi loads TypeScript via jiti. Edit `src/` and
`/reload` (or restart pi).

## Development loop

- `npm run typecheck` — `tsc --noEmit`, must be clean.
- `npm test` — offline smoke suite; no herdr required. Must pass.
- `npm run test:live` — requires a running herdr session + a working model for
  spawned agents.
- `npm run test:win` — Windows-only live test of the `pane run` launch path + every
  orchestration tool; self-skips on non-Windows.
- `npm run test:stress` — 5 parallel agents doing real multi-tool work, with
  on-disk artifact verification. The strongest correctness check.
- **Isolated live test (no install):** from a clone, open a herdr tab and run
  `pi -ne -e ./src/index.ts`. `-ne` disables installed-extension discovery so only
  your local `src/` loads — drive it to exercise the tools end-to-end against a
  real herdr server without touching your installed copy.

## Guidelines

- **Keep the cross-cutting contract.** Every tool returns the uniform `Result<T>`
  envelope and uses the `HerdrErrorCode` set. Treat all herdr CLI output as
  untrusted — parse the envelope, never pass raw stdout to the LLM.
- **One spawn module.** All herdr invocations go through `src/herdr.ts`. Don't
  shell out to `herdr` elsewhere.
- **Timeouts everywhere.** Any blocking operation takes/ honors a `timeoutMs`
  and resolves to `TIMEOUT` rather than hanging. Honor `ctx.signal` / the abort
  signal where available.
- **Label destructive tools.** Anything that closes/terminates/kills must say so
  in its `description` (the ⚠️ convention).
- **Don't infer agent state from the rendered spinner.** Tool-call output replaces
  it. Completion is read only from herdr's state events (self-report + transition
  waits). See README › "How completion is detected".
- **Platform differences stay in the launcher.** New presets go through the
  `HERDR_PRESET_*` map; the `cmd /c` wrapper is the launcher's job, not the LLM's.
- **Branch on herdr version when a CLI command changes.** herdr 0.7.5 redesigned
  several commands (`agent start`, removed `agent send` → `agent prompt`, and now
  emits error envelopes on stderr). The extension detects the version once
  (`src/version.ts`) and branches; when you touch a herdr command that differs
  across versions, follow that pattern instead of assuming one API.
- **Platform-gate when a herdr command is broken on one OS.** herdr 0.7.5-preview's
  `agent start --kind` is Windows-broken (PowerShell `Start-Process` can't launch
  npm shims), so `startAgentNew` branches on `process.platform === "win32"` to
  launch via `pane run` + herdr auto-detect instead, leaving the macOS/Linux
  `agent start` path intact. When a herdr command works on one platform but not
  another, gate on platform and keep the working path untouched.

## Adding a tool

1. Pick the tier file (`tools/orchestration.ts`, etc.) and register with `pi.registerTool`.
2. Build argv → `herdr()` → return via the `unwrap`/`okText`/`fail` helpers.
3. Add a `promptSnippet` + `promptGuidelines` (name the tool in each guideline).
4. Cover it in `tests/smoke.mjs` (offline) and, if it touches herdr, a live test.

## Reporting issues

When reporting a state-detection or completion bug, please include:

- the pane id and `herdr agent get <pane>` output (the `agent_status`),
- the last ~15 lines of `herdr agent read <pane> --source visible`,
- whether the spawned agent loads this extension (footer shows `herdr:`),
- your platform, pi version, and herdr version (`herdr --version`).

Thank you!
