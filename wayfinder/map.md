# Wayfinder map — pi-herdr v0.6: the subagent experience layer

label: `wayfinder:map`

## Destination

A fully-decided spec for **pi-herdr v0.6**, the subagent experience layer: a **session-file substrate** (parent-owned child session files + injected child extension), **hybrid push/pull result delivery** with user-takeover semantics and idle re-arm, a **10-state projected lifecycle** with watchdog supervision, **fork/lineage/standalone session modes**, **interrupt + resume**, a **5-level model/thinking routing chain**, a rich **fleet widget**, **tintinweb-style scripted workflows**, a **12-tool surface** cut down from 43, and a hard **herdr ≥0.9.0** floor. Ready to implement as ordinary work — **no implementation inside this map**.

## Notes

- Repo: this one. **Supersedes the v0.5 map** (archived at `archive/v0.5-map.md` with its 11 tickets — the provenance of every decision that survived). Prior art: [`0xRichardH/pi-herdr-subagents`](https://github.com/0xRichardH/pi-herdr-subagents) (delivery/status/session-modes reference — detail: [research/richardh-prior-art.md](research/richardh-prior-art.md)), [`tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents) (workflows runtime port + UX reference), `nicobailon/pi-subagents` ([research/nicobailon-prior-art.md](research/nicobailon-prior-art.md)).
- Local code: `src/` (12-tool surface target; herdr/launcher/selfreport/settings/spawn internals are the kept foundation), `tests/`.
- **Charter decisions — settled at the v0.6 re-spec (grilled 2026-09-19), do not re-litigate:**
  1. **Substrate over observation.** Children are pi launched with parent-owned session files (`pi --session <path-we-seed>`); the injected child extension provides `agent_done`, session naming (`herdr/<spawn-name>`), the activity recorder, completion sidecars, and the identity/tools strip. Results are read from session JSONL (exact last assistant message, `stopReason`/`errorMessage` mining). Pane-tail reading survives only as fallback for panes we didn't spawn. Session files live in **pi's default sessions dir** (`~/.pi/agent/sessions/--<cwd>--/`) so any spawned session is resumable/perusable from plain pi (`/resume`, `pi --session`).
  2. **Hybrid delivery, automatic — not a knob.** Push on completion: full final assistant message steered into the orchestrator with wake (`notifications: normal` = wake, `quiet` = next natural turn, blocked always wakes). Two completion routes: auto-settle (autonomous child, `agent_settled` → sidecar → pane closes) and declared (`agent_done` tool). Pull anytime: `get_agent_result` = inspection (snapshot, bounded wait, re-read). **User takeover** disables auto-close only — the result contract is never revoked (`agent_done` stays, session always readable); **idle re-arm** (15 min default, configurable; timer from `agent_settled`, any keystroke resets) auto-delivers the latest final message (labeled *auto-delivered after user steer*) and closes the pane; quiet `user took over <agent>` note to the orchestrator. No `<task-notification>` doorbell — the push carries the letter.
  3. **10-state projected vocabulary.** `queued | starting | active | waiting | blocked | interrupted | stalled | running | finalizing | gone`, derived from three sources: herdr pane inspection (coarse authority), child activity snapshots (current tool — what makes `active · bash 7m` possible), and the watchdog (stall/recover). Interactive/autonomous split governs stall pings (autonomous ping the orchestrator, interactive stay widget-only). `gone` = terminal with registry metadata + retained session surviving.
  4. **Launch = argv plan + herdr.** A "launch plan" builder composes the pi argv (`--session`, `-e` child extension, `--model`/`--thinking` from routing, `--system-prompt`/`--append-system-prompt` per `prompt_mode`, long tasks as artifact files); herdr stays the process launcher (`agent start --kind pi --pane <id> -- <argv>`). Frontmatter `args:` (spawn-level `agent_args` appends/overrides) — the plannotator `--plan` planner rides this. **No multi-harness driver layer**; non-pi kinds remain herdr `--kind` passthrough with the honest one-liner.
  5. **Routing chain (5 levels).** spawn `model`/`thinking` > frontmatter > `models.agents.<name>` (settings) > `models.default` (settings) > parent session's model; `thinking` resolves the same way. Enforce-or-error validation names the level that lied.
  6. **Session modes.** `standalone` (default) | `lineage-only` (header link, no turns) | `fork` (full parent conversation copied, truncated before the parent's last user message). Frontmatter `session-mode:` + spawn-level override (`fork: true`). Honest costs: fork is a context-copy tax and a snapshot.
  7. **Lifecycle tools.** `interrupt_agent(target)` — turn-level cancel (Escape), state flips to `interrupted`, stale snapshots discarded, composes with `message_agent` as stop-and-redirect. `resume_agent(target, message?)` — registry handle (never a raw path), relaunch `pi --session <retained>` with a re-derived plan, same gates, re-enters supervision; the documented recovery move for `gone` agents.
  8. **Widget = table + our alarms.** One row per in-flight agent (elapsed, name, `state · tool`, state age); header `active`/`open` counts; amber border when nothing active; rows leave on delivery. Kept from v0.5-05: blocked callout beneath (the one loud alarm), footer replacement, read-only. Child-side identity/tools strip (Ctrl+J) in every spawned pane.
  9. **Scripted workflows in** (reverses the v0.5 out-of-scope ruling). Port tintinweb's runtime: vm sandbox, `agent()`/`pipeline()`/`parallel()`/`workflow()`/`phase()`/`log()`/`args`/`budget`, determinism jail, resume journal (`resumeFromRunId`, prefix replay), saved-workflow dirs (`.pi/workflows/` → `.agents/workflows/` → global), progress card. The host seam calls our spawn machinery — the substrate IS the `agent()` primitive. `gate`, `label`/`resume`, `isolation: "worktree"` map to existing decisions; concurrency flows through the ordinary gates. Schema/StructuredOutput = stretch. FleetView inspector (pause/skip/retry) deferred post-v0.6.
  10. **Surface: 43 → 12, single surface.** Kept: `herdr_spawn_agent`, `herdr_get_agent_result`, `herdr_message_agent`, `herdr_interrupt_agent`, `herdr_resume_agent`, `herdr_save_agent`, `herdr_list_agents`, `herdr_run_workflow`, + pane-sync quartet (`herdr_run_command`, `herdr_read_pane`, `herdr_wait_output`, `herdr_send_keys`). Deleted from the model surface: all layout, worktree CRUD, introspection, tabs/workspaces, `herdr_delegate`. The `surface` setting dies. Machinery survives internally (worktrees for `isolated`, pane focus for "go look"). Command: `/subagents config` (bare `/subagents` same); tools keep the `herdr_` prefix.
  11. **herdr ≥0.9.0 hard floor.** Below → one clean `HERDR_TOO_OLD` error with upgrade pointer. Deleted: the 0.7.3 API branch, the Windows 0.7.5–0.8.x `pane run`/auto-detect fallback, the 0.8.2 `agent_not_ready` workarounds. Kept: version probe (diagnostics/footer) + self-report (orthogonal insurance).
- Standing preference: minimal surface, honest state, herdr visibility as the safety net — the surface got *smaller* even as the experience got richer.

## Decisions so far

All ten tickets closed at the re-spec grill (2026-09-19); see tickets for full resolutions:

- [01 Substrate: session files + child extension](tickets/01-substrate.md) — session files in pi's default dir, seeding, `agent_done`, naming, activity recorder, sidecars, identity strip; pane-tail demoted to fallback.
- [02 Push delivery + takeover](tickets/02-push-delivery.md) — full-result steer, done/error/ping routes, takeover split, idle re-arm, quiet note, verbosity re-semantics *(supersedes v0.5-04)*.
- [03 Status projection + watchdog](tickets/03-status-projection.md) — 10 states, three sources, stall/recover pings, interactive/autonomous split.
- [04 Launch plan + routing](tickets/04-launch-plan-routing.md) — argv builder, 5-level chain, frontmatter `args:`, task-as-artifact.
- [05 Session modes](tickets/05-session-modes.md) — standalone/lineage-only/fork, seeding rules, `/resume` visibility, honest costs.
- [06 Interrupt + resume](tickets/06-interrupt-resume.md) — `interrupt_agent` + `resume_agent` semantics.
- [07 Widget](tickets/07-widget.md) — table + blocked callout + footer replacement + child strip *(supersedes v0.5-05)*.
- [08 Workflows](tickets/08-workflows.md) — tintinweb runtime port, host seam, journal, saved dirs, card; schema stretch, inspector deferred *(reverses the v0.5 out-of-scope ruling)*.
- [09 Surface cut + `/subagents config`](tickets/09-surface-cut-settings.md) — 43→12, settings table, deprecation discipline *(supersedes v0.5-03 surface keys + v0.5-06)*.
- [10 Version floor](tickets/10-version-floor.md) — herdr ≥0.9.0 gate, legacy deletion, probe/self-report kept.

## Not yet specified

- `schema`/StructuredOutput child-tool design — stretch inside ticket `08`, decided at implementation if attempted.
- Workflow inspector (pause/skip/retry keys, conversation viewer) — post-v0.6 revisit, FleetView-class UI.
- `budget.spent()` real values — usage from session JSONL where present, else honest `Infinity`; decide at implementation.
- Widget activity detail for non-pi passthrough panes — `running` stays coarse.
- `@agent` mentions + FleetView — post-v0.6 revisit (unchanged).
- Blocking ask/reply semantics — post-v0.6 revisit (unchanged).

## Out of scope

- Multi-machine herdr (0.9 remote agents) — natural future home for spawn-a-remote-agent; untouched in v0.6.
- Building a message broker / IPC bus — herdr-native channel chosen; unchanged ruling.
- Non-pi child support beyond the promise-free `kind` passthrough — unchanged ruling; no driver layer.
- In-process subagent execution — still panes; unchanged.
