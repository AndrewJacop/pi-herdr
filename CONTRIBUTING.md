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
- `npm run test:stress` — 5 parallel agents doing real multi-tool work, with
  on-disk artifact verification. The strongest correctness check.

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
