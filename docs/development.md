# Development & testing

How to develop, test, and extend pi-herdr. For what the tools *do*, start at the
[README](README.md); for cross-cutting behavior see [concepts](concepts.md).

## Functional test (offline, the gate)

Two commands, no herdr required, must stay green:

```bash
npm run typecheck     # tsc --noEmit — must be clean
npm test              # node tests/smoke.mjs — offline smoke; 378 checks, all pass
```

`tests/smoke.mjs` is the offline gate. It does **not** require a running herdr server.
It covers:

- **Extension load + tool registration** — all **43** tools register with the
  expected names, each has a `parameters` schema and an `execute()`, and the
  self-report hooks wire up when running inside herdr.
- **Launcher argv** — preset → platform argv expansion (`pi` → `cmd /c pi` on
  Windows, `pi` elsewhere), explicit-`argv` override, unknown-preset → `VALIDATION_ERROR`.
- **`herdr()` envelope & error mapping** — success envelope → `result`; error
  envelope → mapped code; **stderr** error envelope (0.7.5 emits errors on stderr);
  `textOk` raw-text path; missing binary → `HERDR_UNAVAILABLE` (no throw/hang);
  hanging process → `TIMEOUT` (fires promptly).
- **Version detection** — `parseVersion`, `isNewAgentApi` boundary at 0.7.5,
  probe `ok`/`missing` states, `detectHerdrVersion` e2e.
- **Version-branched argv builders** — `transitionWaitArgs` (`agent wait --until`
  vs `wait agent-status`), `promptWaitArgs` (`agent prompt --wait`), with multi-status
  and stringified `--timeout`.
- **Agent-kind validation** — `parseAgentKinds`, `AGENT_KINDS_FALLBACK`, per-session
  cache, and the pure `kindError` unknown-kind path; confirms `argv` is dropped and
  `agent` is a free string.
- **Pure argv builders** for Tier 2–5 — `listPanesArgs`/`resizePaneArgs`/
  `zoomPaneArgs`/`movePaneArgs`/`swapPanesArgs`/`createTabArgs`/`createWorkspaceArgs`,
  `waitOutputArgs`, and the worktree/introspection builders, plus the snake_case →
  camelCase normalizers.
- **Destructive labels (AC7)** — every ⚠️ tool's `description` carries the marker.

Current count: **378 passed, 0 failed**.

## Live QA by group

Functional gate first, then a live sweep against a real herdr server. The live QA
prompt lives locally at `.pi/prompts/herdr-qa.md` (not tracked here) and is invoked as:

```text
/herdr-qa <group>
```

It runs the offline gate, then exercises one group's tools end-to-end against a live
herdr. The seven groups:

1. **orchestration** — spawn/drive/wait/harvest agents, `delegate`.
2. **pane-sync** — split/run/read/wait-output/send-keys/close.
3. **panes** — list/get/resize/zoom/move/swap.
4. **tabs** — list/create/get/focus/rename/close.
5. **workspaces** — list/create/get/focus/rename/close.
6. **worktrees** — create/open/list/remove.
7. **introspection** — snapshot + session list/stop/delete.

**Safety rules** the QA prompt enforces:

- Destroy **only self-created throwaways** — never an existing workspace/tab/pane.
- `herdr_session_stop` / `herdr_session_delete` operate on **non-existent** names so
  they hit the not-found path, not your real session.
- All agent/pane names are **lowercase `[a-z0-9-_]`**.

## Task workflow

Coordinated work uses two local prompts (orchestrator + worker), backed by the task
ledger at [`docs/internal/v0.2.5-tasks.md`](internal/v0.2.5-tasks.md) (internal, not
user-facing):

- `/herdr-tasks` — the orchestrator view over the task ledger.
- `/herdr-task <id>` — run one worker for a specific task id.

These are authoring/coordination aids, not part of the shipped tool surface.

## Adding a tool

The cross-cutting contract is spelled out in [`CONTRIBUTING.md`](../CONTRIBUTING.md)
([guidelines](../CONTRIBUTING.md#guidelines)). Five-step checklist:

1. **Pick the tier file** — add a `pi.registerTool({...})` in
   `tools/orchestration.ts` (agents), `tools/sync.ts` (raw panes),
   `tools/layout.ts` (panes/tabs/workspaces), `tools/worktrees.ts`, or
   `tools/introspection.ts`. Register in the file's existing order.
2. **Build argv → `herdr()` → return** via the shared `okText` / `fail` helpers (and
   `err()` for local validation). **All** herdr invocations go through the single
   spawn module `src/herdr.ts` — never shell out elsewhere. Treat herdr output as
   untrusted; parse the envelope, never pass raw stdout to the model.
3. **Version-branch on 0.7.5** when the underlying `herdr` command changed (see
   [concepts › version branching](concepts.md#version-detection--branching)); use the
   pure argv-builder pattern so the branch is unit-testable offline. **Platform-gate**
   when a command is broken on one OS (e.g. Windows `agent start --kind`).
4. **Mark ⚠️ destructive** in the `description` if it closes/terminates/kills/deletes,
   and give every blocking path a `timeoutMs` + `AbortSignal` (resolve `TIMEOUT`, not
   hang). Add a `promptSnippet` + `promptGuidelines` that name the tool.
5. **Add smoke coverage** in `tests/smoke.mjs` (offline, always) — assert registration,
   the argv builder, and any error/validation path — plus a live test if it touches
   herdr. `npm run typecheck && npm test` must stay green.

For a no-install live check while developing: open a herdr tab and run
`pi -ne -e ./src/index.ts` (`-ne` loads only your local `src/`).

## Cross-links

- [README](README.md) — install, quickstart, tool catalog.
- [concepts](concepts.md) — `Result<T>`, version branching, surfaces, ⚠️ tools.
- Tools: [orchestration](tools/orchestration.md) · [pane-sync](tools/pane-sync.md) ·
  [panes](tools/panes.md) · [tabs](tools/tabs.md) · [workspaces](tools/workspaces.md) ·
  [worktrees](tools/worktrees.md) · [introspection](tools/introspection.md).
