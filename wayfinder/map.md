# Wayfinder map — pi-herdr v0.5: the agent-experience layer

label: `wayfinder:map`

## Destination

A fully-decided spec for **pi-herdr v0.5**, the agent-experience layer: `spawn_agent`/`get_agent_result`/`steer_agent` + pane-sync surface, `.md` agent registry with shipped defaults and session-ephemeral agents, `/herdr` settings menu, badge + notification + widget UI, and a herdr-native open inter-agent message channel. Ready to implement as ordinary work — **no implementation inside this map**.

## Notes

- Repo: this one. Prior art: [`tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents) (the UX reference), [`nicobailon/pi-subagents`](https://github.com/nicobailon/pi-subagents) (npm `pi-subagents`, has herdr integration), [`pi-intercom`](https://pi.dev/packages/pi-intercom). Local code: `src/tools/*.ts` (43-tool surface), `src/selfreport.ts` (state bridging), `src/version.ts` (herdr probes).
- Skills: `/grilling` + `/domain-modeling` for decision tickets; `/research` for AFK reading; `/prototype` for the widget ticket.
- **Charter decisions — settled at charting, do not re-litigate:**
  1. Spec-first: map decides; implementation happens after, outside wayfinder.
  2. LLM surface: `spawn_agent` + `get_agent_result` + `steer_agent` + pane-sync quartet (`run_command`, `read_pane`, `wait_output`, `send_keys`). Layout/worktrees/introspection leave the model's view behind a `"surface": "full"` escape hatch; worktree becomes an `isolated` spawn param.
  3. Agent files: `.md` + YAML frontmatter, tintinweb-compatible field names + herdr keys (`kind`, spawn args). Locations: `~/.pi/agent/agents/` global, `.pi/agents/` project (wins). Session-ephemeral registry precedence: session > project > global > built-ins.
  4. Authoring: `spawn_agent` with inline `agent:` definition for on-the-fly agents; `save_agent` persists to project/global (no gate by default); chat co-creation = model conversation + `save_agent`.
  5. `/herdr` command: settings menu — `save_agent` gating, max parallel sessions (queue beyond), agents kill-switch, `surface: full`, default kind, notification verbosity, max spawn depth.
  6. UI: tool badge (`renderCall`/`renderResult`) + completion notifications (no token/cost claims — external CLIs don't report them) + above-editor **status-honest** widget (working/blocked/idle + age; blocked made loud). FleetView/conversation-viewer and `@mentions` excluded from v0.5; "go look" = focus the pane.
  7. Inter-agent messaging: **herdr-native channel, no broker**. `message_orchestrator` (return-address env var `PI_HERDR_ORCHESTRATOR_PANE`) + `message_agent(name | pane-id)` — **open fleet, anyone↔anyone**, all kinds (non-pi children participate via CLI convention). Blocking ask/reply deferred. Escalations ride blocked-state (existing self-report bridge).
  8. Fidelity honesty: duration + status only for external children; no invented token counts.
- Standing preference: minimal surface, honest state, herdr visibility as the safety net.

## Decisions so far

- [spawn_agent surface](tickets/01-spawn-agent-surface.md) — `type` xor `agent` (full field set, enforce-or-error per kind); `name` = pane handle w/ fallback chain; `kind`/`model` overridable (merge+validate); `isolated: true` boolean (herdr-side worktree); background default + `wait?: ms | true` (terminal = done or blocked); blocked = distinct terminal state w/ question, no auto-relay; no resume; depth via `PI_HERDR_SPAWN_DEPTH` env counter checked before side effects; no layout params.
- [Capability→flag matrix for agent CLIs](tickets/08-capability-matrix.md) — portable: model pin, system prompt, headless, cwd; portable-ish: tool allow/deny (codex config-only); kind-specific: skills (pi-only), extensions/MCP; never promise child worktree creation. Detail: [research/capability-matrix.md](research/capability-matrix.md)
- [nicobailon pi-subagents prior art](tickets/09-nicobailon-prior-art.md) — its herdr integration is status-bridge + inspector panes via the herdr CLI (coexistable); it abandoned env-var child-config (07 must pin pi-intercom's live contract); borrow its notification-reliability patterns for 04; avoid its runner machinery — herdr panes replace it. Detail: [research/nicobailon-prior-art.md](research/nicobailon-prior-art.md)

## Not yet specified

- Blocking ask/reply semantics — revisit after v0.5: grow native vs adopt pi-intercom (pi-only). Decide from real usage pain.
- Widget activity lines for pi children via self-report v2 (child reports current tool to herdr).
- Spawn-prompt etiquette for open addressing (how spawners pass names down) — sharpens with the messaging spec.
- `@agent` mentions + FleetView — post-v0.5 revisit.

## Out of scope

- Scripted workflow orchestration (`SubagentWorkflow` equivalent) — not in v0.5.
- Building a message broker / IPC bus — herdr-native channel chosen; broker explicitly rejected.
- In-process subagent execution — tintinweb's model; pi-herdr stays panes.
