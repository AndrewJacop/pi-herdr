---
label: wayfinder:prototype
status: closed
assignee: Andrew Jacop
blocked-by: []
---

## Question

What should the above-editor fleet widget look like? Prototype a rough concrete artifact to react to (mock render of the widget lines for a realistic fleet: 2 working, 1 blocked, 1 idle-aged, mixed kinds) — then decide: line format per agent (spinner/status icon, name, kind badge, age), how loud `blocked` gets, whether the footer status line survives alongside or is replaced, and any focus/interaction affordance ("go look" = focus pane). Status-honest: no activity lines, no token counts (charter item 6/8) — unless self-report v2 (fog) lands. Use the `/prototype` skill.

## Resolution

HITL-prototyped + grilled (wayfinder work-through session). Artifact: `prototype/05-widget/widget.mjs` — throwaway, three structurally different variants (A panel / B summary / C alarm) with fleet (mixed 5-agent ↔ calm) and footer toggles, captured on throwaway branch `prototype/05-widget` (commit `e80ca38`), out of `main`; **variant B won**.

1. **Shape: B · summary.** One ambient line whenever any agent exists: `herdr ▏ ⠋ research·4m · ⠋ db-migrator·12m · ⏳ lint-sweep · ○ explorer·2h` — working = green spinner + name·age, queued = dim ⏳ + name, idle = dim ○ + name·age. Wraps naturally, no entry cap (fleets are small; /herdr shows all). A (boxed panel) rejected: ~7 lines of permanent overhead; C (alarm-only) rejected: loses the ambient per-agent awareness the charter wants.
2. **Blocked: exists only as its callout.** Blocked agents are pulled out of the ambient line entirely (never counted twice) and render directly beneath it: `⚠ reviewer BLOCKED 8m claude "Schema A (wide) or B (tall)…"` — inverse-video name+status, kind badge, age, question preview truncated with ellipsis. This is the widget's alarm; no other loudness mechanism.
3. **Footer: the widget replaces the count.** While the widget has ≥1 line, the footer's `herdr: N agents (M working)` status is dropped — the widget carries it (they render ~2 lines apart; double display is pure duplication). Footer keeps diagnostics only: `herdr: not installed — herdr.dev`, `herdr: unavailable`, version tag. Empty fleet → no widget lines, no footer count.
4. **Aged-idle: ambient only, dim — no callout, ever.** Past 1h idle the icon turns yellow ◔ and the age bolds; that is the only emphasis. Rationale: idle is the healthy resting state, ticket 04's notifications already announced completion (with `resultConsumed` suppression for missed pickups) — the widget must not re-nag.
5. **Read-only. No affordance in v0.5.** No hint lines, no keybinding, no /herdr changes (ticket 03's settings-menu scope stands). "Go look" = herdr-native pane navigation (the human is already in the herdr TUI) or ask the model, which has `herdr_focus_agent`.

**Data contract:** the widget renders the whole fleet from the same 5s poll loop + last-seen map built for ticket 04 — one watcher, two consumers; the spawn registry supplies ages for all kinds. herdr pane states map to icons: working → spinner, blocked → callout, idle → ○/◔, queued → ⏳ (pre-pane, ticket 03's queue). `done`/`gone` are not widget states — vanished panes just stop listing (04 owns terminal bookkeeping). Status-honest per charter 6/8: status + age only; activity lines remain fog — self-report v2 would extend exactly this ambient line later.
