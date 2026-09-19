---
label: wayfinder:grilling
status: closed
assignee: Andrew Jacop
blocked-by: [08-capability-matrix]
---

## Question

The exact `spawn_agent` parameter surface and semantics: `type` vs inline `agent:` definition (field set for on-the-fly agents), `name`, per-call `kind`/`model` overrides, `isolated` (worktree) param, background-by-default vs `wait: true`, blocked-agent handling (does a blocked child surface as a distinct result/notification?), resume semantics (if any), and where the max-spawn-depth check hooks in. Constraint: every param must be honestly enforceable per kind — zoom ticket `08`'s matrix before deciding; drop or mark per-kind-optional anything that isn't. Charter items 2/3/4 in the map's Notes are settled — this ticket specifies, not re-opens.

## Resolution

All decisions HITL-grilled 2025-12-04, every param cross-checked against ticket `08`'s capability matrix.

1. **Specifier: `type` xor `agent`, exactly one required.** `type: "Explore"` resolves through the registry (session > project > global > built-in); `agent: {...}` is the inline on-the-fly definition sharing the `.md` frontmatter schema. Both → error; neither → error; no silent default agent.
2. **Inline field set + enforce-or-error.** Fields (snake_case, tintinweb-compatible + herdr keys): `name`, `description`, `kind` (default = settings default kind), `model`, `system_prompt`, `tools`, `exclude_tools`, `skills`, `agent_args` (raw-flags escape hatch). Honesty rule: if the chosen kind cannot enforce a set field, the spawn **errors** naming the field and pointing at `agent_args` or another kind — never silently dropped. Per-kind: `system_prompt` pi/claude ✔ codex ✘ (config-only); `tools`/`exclude_tools` pi/claude ✔ codex ✘ (no general allowlist); `skills` pi-only.
3. **`name` = pane handle with fallback chain.** Spawn-level `name` is how the pane is addressed later (`steer_agent`, `message_agent`, `get_agent_result`); defaults to the definition's name; anonymous inline agents get herdr's auto `agent-<timestamp>` (herdr unique-ifies collisions). A definition's `name` is registry identity, never a forced handle.
4. **`kind`/`model` overridable per call.** Merge order: definition < spawn param; enforce-or-error validates the **merged** spec once (e.g. `type: "Explore", kind: "claude"` fails if Explore pins `skills:`). Definitions are defaults, not straitjackets.
5. **`isolated: true`, boolean only.** Herdr-side worktree (auto branch+path via existing worktree machinery), child `cwd` = worktree, pane in current workspace. No branch/base/path knobs — exotic needs compose `herdr_worktree_create` + `cwd`. Teardown stays manual (`herdr worktree remove`), documented. Kind-agnostic (matrix: child-flag worktrees unpromisable; this is pi-herdr-side).
6. **Background by default.** Spawn returns `{name, paneId, status}` immediately; completion reaches the parent via notifications (ticket `04`) + `get_agent_result`. `wait?: number | true` — number = bounded ms, returns current state on expiry; `true` = until terminal (done or blocked). `herdr_delegate` remains the one-shot blocking tool with `onBlocked` semantics.
7. **Blocked = distinct terminal state.** `wait: true` ends on done **or** blocked; `get_agent_result` on a blocked child returns `{status: "blocked", question, handle}` (child's ask-user text where extractable); parent relays via `steer_agent` or a human answers in the pane; ticket `04` fires a distinct loud blocked notification. **No auto ask-user relay** into the parent session — that hijack is `herdr_delegate`'s `onBlocked: "return"` alone.
8. **No resume in v0.5.** Fresh spawn only; live panes → `steer_agent`; kind-native resume flags (`claude --continue` etc.) reachable via `agent_args`.
9. **Depth via `PI_HERDR_SPAWN_DEPTH` env counter.** Unset = 1; spawn reads + increments; if over the settings max-spawn-depth (ticket `03`), refuse **before any pane/worktree side effect**; child env stamped with the incremented value. Only pi→pi chains can spawn anyway (non-pi children run no pi-herdr). Single-int contract, same class as `HERDR_PANE_ID` / `PI_HERDR_ORCHESTRATOR_PANE` — ticket `07` should glance at it in its env-contract pass.
10. **No layout params.** Per charter item 2: no `split`/`tabId`/`workspaceId`/`focus` on `spawn_agent` — those stay behind `surface: "full"`. Kept: `prompt` (required), `cwd`, `wait`, `isolated`, `name`, `kind`, `model`, `type`/`agent`.

**Follow-on:** get_agent_result/steer_agent had no owning ticket → created `10-result-steer-surface` (anchored to the decisions above).
