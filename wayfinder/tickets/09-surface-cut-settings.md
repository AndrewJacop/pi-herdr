---
label: wayfinder:grilling
status: closed
assignee: Andrew
blocked-by: []
---

## Question

The model-facing tool surface and the settings command. Supersedes v0.5-03's `surface` key and v0.5-06's agents/full split — the user's ruling: 43 tools is far too much, hardly any are used, and the chunk gets removed. Also settles the `/herdr` rename and the settings table after the v0.6 decisions.

## Resolution

1. **One surface, twelve tools.** The `surface: agents|full` setting dies; there is nothing to switch to.

   | # | Tool | Notes |
   |---|---|---|
   | 1 | `herdr_spawn_agent` | amended: session modes (05), routing (04), `fork: true`, stance overrides |
   | 2 | `herdr_get_agent_result` | inspection tool — pull path (02) |
   | 3 | `herdr_message_agent` | unchanged ruling (v0.5-11) |
   | 4 | `herdr_interrupt_agent` | new (06) |
   | 5 | `herdr_resume_agent` | new (06) |
   | 6 | `herdr_save_agent` | unchanged (v0.5 charter 4) |
   | 7 | `herdr_list_agents` | unchanged, absorbs fleet introspection duty |
   | 8 | `herdr_run_workflow` | new (08) |
   | 9–12 | `herdr_run_command`, `herdr_read_pane`, `herdr_wait_output`, `herdr_send_keys` | the pane-sync quartet — raw pane control, option-list answers, fallback reads |

2. **Deleted from the model surface:** all layout tools (split/swap/resize/zoom/move), tab/workspace CRUD, worktree CRUD, introspection beyond `list_agents`, and `herdr_delegate` (spawn + `get_agent_result(wait: true)` is its composition; push makes it redundant). **Machinery survives internally** — worktree create/remove powers `isolated`, pane focus powers "go look", `agent list/get` powers the poll loop. Code deletion ≠ capability deletion; the LLM just stops seeing it.
3. **Tools keep the `herdr_` prefix** — four characters buy zero collision risk in the subagent-tool namespace (`subagent`, `Agent`, `SubagentWorkflow` all live there); renaming eleven tools breaks resumed sessions for no user-visible gain.
4. **Command rename: `/subagents config`.** Pi commands take a freeform argument; `/subagents` with first word `config` opens the settings menu, bare `/subagents` does the same (arg optional). Future words can grow siblings (`/subagents kill-all`). Kill-all stays a confirmed menu action either way.
5. **Settings table after v0.6** (deep-merge project-wins, writes-persist-to-owning-file, flat interactive list — v0.5-03 mechanics unchanged):

   | Key | Status |
   |---|---|
   | `models.default`, `models.agents.<name>` | **new** — routing levels 3–4 (04) |
   | `idle_rearm_minutes` (15) | **new** — takeover timer (02) |
   | `workflows_enabled` (true) | **new** — removes the workflow tool only (08) |
   | `notifications` none\|quiet\|normal | survives — now governs the push wake (02) |
   | `max_parallel_agents`, `agents_kill_switch`, `max_spawn_depth`, `default_kind` | unchanged |
   | ~~`surface`~~ | **dies** — single surface |
   | ~~`allow_save_agent`~~ | dies with v0.5-03's gate-by-default (`save_agent` ungated now — low risk, reversible by file delete) |

6. **Deprecation discipline (v0.5-06 pattern, breaking change):** CHANGELOG breaking-change entry + README "Upgrading" note listing every removed tool and its composition replacement (`herdr_delegate` → spawn + get(wait); layout/worktrees → herdr UI / `isolated`). No runtime nagging, no shim tools.
7. **README restructure:** subagent-experience-first (spawn → push → widget → workflows), fleet-as-internal-machinery appendix; `/subagents config` documented as the only command.
