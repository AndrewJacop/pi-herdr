---
label: wayfinder:grilling
status: closed
assignee: Andrew Jacop
blocked-by: [09-nicobailon-prior-art]
---

## Question

Coexistence and naming in a shared ecosystem: `spawn_agent` vs tintinweb's `Agent` tool (no collision by name — confirm and document the pairing story: same `.pi/agents/` dir readable by both, in-process vs pane dispatch); interaction with nicobailon's `pi-subagents` (zoom ticket `09` — its herdr integration may already occupy ground we're claiming, e.g. pane spawning or bridge env vars); pi-intercom's `contact_supervisor` env contract vs our `PI_HERDR_ORCHESTRATOR_PANE` convention (compatible? conflicting? which wins if both installed?); and what the install docs promise when multiple orchestrator extensions are active.

Zoom: ticket `02` pinned the `.md` dialect (body = system prompt, comma-list `tools`, `prompt_mode`, unknown keys ignored) — anchor the shared-dir story on those facts.

## Resolution

HITL-grilled 2026-09-19. Overriding stance, stated once and applied to every pairing: **pi-herdr is installed where no other orchestrator/messaging extension is installed — the audiences are disjoint, so there is no co-install story to tell for anyone.** Facts below are verified and recorded so implementers don't re-derive them; none become user-facing promises.

1. **tintinweb `Agent` tool: no pairing.** No tool-name collision is confirmed (`Agent` vs our `spawn_agent` quartet) — co-install is *safe*, but it is not *documented*: whoever runs pi-herdr won't run tintinweb's dispatcher. The registry remains readable by both (fact: same dirs, compatible dialect per ticket `02`), but that's an artifact of the authoring-familiarity choice (charter 3), not a bridge we maintain or document. No shared-dir authoring contract section in the README.
2. **nicobailon `pi-subagents`: no co-install story.** Verified facts, unpromised: its herdr bridge writes display-only metadata via `pane report-metadata` while our selfreport writes lifecycle via `pane report-agent` — separate herdr channels, no write conflict by construction; its children are in-process runners invisible to our fleet tools; its inspector/project panes are ordinary herdr panes (visible in the fleet like any pane). We keep the `herdr:blocked` bridge — it exists for `pi-ask-user`; pi-subagents riding it is incidental. Nothing about its machinery appears in our docs.
3. **pi-intercom: parallel channels, no rule.** Env namespaces are disjoint (`PI_HERDR_*` vs `PI_INTERCOM_*`/`PI_SUBAGENT_*`) — no collision, no precedence, no interop promise. A child that happens to carry both sees both toolsets; the model picks; we read none of their vars and they none of ours. Locked here, per ticket `01`'s glance note and the research's avoid-list: **env-contract discipline — `PI_HERDR_*` vars carry single-value scalars only** (return address, depth int, label, kill-flags), never structured child config (nicobailon's abandoned mistake). Register: `PI_HERDR_ORCHESTRATOR_PANE`, `PI_HERDR_SPAWN_DEPTH`, `PI_HERDR_AGENT_LABEL`, `PI_HERDR_NO_SELF_REPORT`, plus herdr-native `HERDR_PANE_ID`/`HERDR_ENV` (not ours to define).
4. **Install docs: one assumption line.** README install/setup gains exactly: "pi-herdr assumes it is the orchestration layer for its sessions; running other subagent or messaging extensions alongside is untested." No compatibility matrix, no pairing sections. The prior-art credit to tintinweb in the README intro stays.

No new tickets surface; no fog sharpens (spawn-prompt etiquette still waits on the messaging spec, not on coexistence); nothing ruled out of scope.
