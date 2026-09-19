---
label: wayfinder:grilling
status: closed
assignee: Andrew Jacop
blocked-by: []
---

## Question

The `/herdr` settings menu and its storage: full settings schema (key names, types, defaults) and menu structure. Known members from the charter: `save_agent` gating (default off), max parallel agent sessions (queue beyond, default?), agents kill-switch, `surface: full` escape hatch, default `kind`, notification verbosity, max spawn depth (default 3?), intercom/message settings. Storage file (json — project + global, project wins? mirroring tintinweb's `subagents.json`). Also: which settings are hot-reloadable vs restart-required.

## Resolution

HITL-grilled 2025-12 (wayfinder work-through session). Facts cross-checked: `src/config.ts` (no pi settings API exists — env + PATH only today), pi extension docs (`registerCommand`, `ctx.ui.select/confirm/input/custom`, `setActiveTools` removal semantics).

1. **Storage: two JSON files, deep-merge, project wins per key.** Global `~/.pi/agent/herdr.json`, project `.pi/herdr.json` — mirroring the agent-registry convention (charter item 3). Per-key override, not whole-file: a project can override `max_spawn_depth` while inheriting global `default_kind`. The menu writes to whichever file owns the key; a project checkout never mutates global config.
2. **Schema — 7 keys, snake_case, one vocabulary with the tool surface:**

   | key | type | default |
   | --- | --- | --- |
   | `surface` | `"agents" \| "full"` | `"agents"` |
   | `default_kind` | string (validated against live kind list) | `"pi"` |
   | `max_parallel_agents` | number ≥ 1 | `3` |
   | `agents_kill_switch` | bool | `false` |
   | `max_spawn_depth` | number ≥ 1 | `2` |
   | `allow_save_agent` | bool | `false` |
   | `notifications` | `"none" \| "quiet" \| "normal"` | `"normal"` |

   `surface` default `"agents"` — v0.5 is the product; existing 43-tool users get the CHANGELOG/deprecation story (ticket 06). **No messaging key** — the herdr-native channel is core surface, nothing to toggle (YAGNI).
3. **Kill-switch = gate only.** `agents_kill_switch: true` refuses new spawns, checked before any pane/worktree side effect (same hook as the depth check from ticket 01). Running agents finish on their own; config writes never have destructive side effects. Terminating the fleet is the separate menu action (below).
4. **Queue is async.** At cap, `spawn_agent` returns `{name, status: "queued"}` — no paneId yet; the pane spawns when a slot frees. `get_agent_result` on a queued agent → `{status: "queued"}`; `wait: true` waits through the queue; bounded ms returns current state on expiry. Fire-and-forget N tasks, queue drains.
5. **Menu: `/herdr` bare — one flat interactive list** (`ctx.ui.select` family; SettingsList pattern). Rows show `key = effective value (source: project | global | default)`. Order: safety gates (`agents_kill_switch`, `allow_save_agent`), behavior (`surface`, `default_kind`, `max_parallel_agents`, `max_spawn_depth`, `notifications`), then one action row **Kill all agents** (confirm dialog, terminates every running agent pane). Bool rows toggle, enum rows pick, number rows input. **No `/herdr set key value` args form** — settings are user knobs (the model must not flip `allow_save_agent` mid-session); hand-editing JSON stays the scriptable path.
6. **Hot-reload: read-at-use for six keys; `surface` restart-required.** `default_kind`, `max_parallel_agents`, `max_spawn_depth`, `agents_kill_switch`, `allow_save_agent`, `notifications` are consulted at the moment they matter (spawn / save / notify) — the menu writes, the next operation sees it. `surface` is read once at init and needs `/reload`; `setActiveTools` mid-session removal exists but invalidates the prompt prefix cache — user chose cache stability over instant apply. The `surface` menu row is marked restart-required.

**Consumed by:** ticket `06` (surface cut mechanics consume the `surface` key), ticket `04` (verbosity levels consume the `notifications` enum).
