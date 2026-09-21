# Development & testing

How to develop, test, and extend pi-herdr. For what the tools *do*, start at the
[README](README.md); for cross-cutting behavior see [concepts](concepts.md).

## Functional test (offline, the gate)

Two commands, no herdr required, must stay green:

```bash
npm run typecheck     # tsc --noEmit — must be clean
npm test              # offline suite (tests/smoke.mjs + per-area suites incl. tests/modes.mjs); must pass
```

`tests/smoke.mjs` is the offline gate. It does **not** require a running herdr server.
It covers:

- **Extension load + tool registration** — exactly the **10** kept tools register
  with the expected names (and every cut tool is asserted absent), each has a
  `parameters` schema and an `execute()`, and the self-report hooks wire up
  when running inside herdr.
- **`herdr()` envelope & error mapping** — success envelope → `result`; error
  envelope → mapped code; **stderr** error envelope; `textOk` raw-text path;
  missing binary → `HERDR_UNAVAILABLE` (no throw/hang); hanging process →
  `TIMEOUT` (fires promptly).
- **Version floor** — `parseVersion` / `isAtLeast` / `floorError`
  classification (at/above → run, below → `HERDR_TOO_OLD` naming version +
  upgrade pointer, unknown → refused, missing → natural `HERDR_UNAVAILABLE`),
  probe `ok`/`missing` states e2e, and the gate inside `herdr()` itself
  (below-floor calls never spawn; at-floor calls pass through).
- **Argv builders** — `transitionWaitArgs` (`agent wait --until`),
  `promptWaitArgs` (`agent prompt --wait`), with multi-status
  and stringified `--timeout`.
- **Agent-kind validation** — `parseAgentKinds`, `AGENT_KINDS_FALLBACK`, per-session
  cache, and the pure `kindError` unknown-kind path; confirms `argv` is dropped and
  the spawn surface's `kind` is a free string.
- **Worktree machinery** (internal, post-cut) — `createWorktreeArgs`/
  `removeWorktreeArgs` and the normalizers that power `isolated`, plus the
  absence of `src/tools/layout.ts` / `src/tools/introspection.ts`.
- **Destructive labels (AC7)** — every ⚠️ tool's `description` carries the marker.

Current count: **178 passed, 0 failed**. Per-area suites (each with its own
`node tests/<area>.mjs` runner): `substrate` (89), `settings` (111),
`launchplan` (77), `modes` (31), `spawn` (121), `agentfiles` (71), `message`
(45), `lifecycle` (71), `delivery` (68), `status` (86), `widget` (51),
`workflow` (118 — runtime + host seam + runs/tool, issue 12).

## Live QA by group

Functional gate first, then a live sweep against a real herdr server. The live QA
prompt lives locally at `.pi/prompts/herdr-qa.md` (not tracked here) and is invoked as:

```text
/herdr-qa <group>
```

It runs the offline gate, then exercises one group's tools end-to-end against a live
herdr. The groups (post-cut):

1. **agent surface** — spawn (via `herdr_spawn_agent`), send/wait/read, list.
2. **pane-sync** — run/read/wait-output/send-keys.

**Safety rules** the QA prompt enforces:

- Destroy **only self-created throwaways** — never an existing workspace/tab/pane.
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

1. **Pick the module** — add a `pi.registerTool({...})` in `tools/orchestration.ts`
   (agent surface), `tools/agents.ts` (spawn entry point), or `tools/sync.ts` (raw
   panes). Register in the file's existing order.
2. **Build argv → `herdr()` → return** via the shared `okText` / `fail` helpers (and
   `err()` for local validation). **All** herdr invocations go through the single
   spawn module `src/herdr.ts` — never shell out elsewhere. Treat herdr output as
   untrusted; parse the envelope, never pass raw stdout to the model.
3. **No version branches, no platform gates** — the extension targets exactly
   herdr ≥ 0.9.0 with one command surface (the floor gate in `src/herdr.ts`
   enforces it); keep new argv shapes in pure builders so they're
   unit-testable offline.
4. **Mark ⚠️ destructive** in the `description` if it closes/terminates/kills/deletes,
   and give every blocking path a `timeoutMs` + `AbortSignal` (resolve `TIMEOUT`, not
   hang). Add a `promptSnippet` + `promptGuidelines` that name the tool.
5. **Add smoke coverage** in `tests/smoke.mjs` (offline, always) — assert registration,
   the argv builder, and any error/validation path — plus a live test if it touches
   herdr. `npm run typecheck && npm test` must stay green.

For a no-install live check while developing: open a herdr tab and run
`pi -ne -e ./src/index.ts -e <pi-ask-user>/index.ts`. `-ne` is **required** here —
the globally-installed `@andrewjacop/pi-herdr` would otherwise collide with your
local copy on tool names and refuse to boot; `-e` then re-adds your local `src/`
plus any other plugin you need (`pi-ask-user` lives at
`~/.pi/agent/npm/node_modules/pi-ask-user/index.ts` — load it to exercise the
blocked / self-report path). `npm run test:live` includes `tests/dev-load.mjs`,
which asserts this combination boots cleanly.

## Cross-links

- [README](../README.md) — install, quickstart, tool catalog.
- [concepts](concepts.md) — `Result<T>`, version floor, surfaces, ⚠️ tools.
- Tools: [agent tools](tools/orchestration.md) · [pane-sync](tools/pane-sync.md).
