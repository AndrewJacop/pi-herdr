---
label: wayfinder:grilling
status: closed
assignee: Andrew
blocked-by: [03-status-projection, 02-push-delivery]
---

## Question

The orchestrator's ambient view of the fleet. Supersedes v0.5-05 (`archive/v0.5-tickets/05-widget.md`) — the minimal one-line summary (variant B) is replaced by the prior art's table (research/richardh-prior-art.md §8), with three of our v0.5 decisions kept as amendments because they were better.

## Resolution

1. **Adopted — the table:**

   ```
   ╭─ Subagents ───────────────── 1 active · 1 open ─╮
   │ 00:23  Scout: Auth (scout)      active · bash 7m │
   │ 00:45  Scout: DB (scout)              waiting 2m │
   ╰──────────────────────────────────────────────────╯
   ```

   - One row per tracked agent: process elapsed (`MM:SS`, freezes at `finalizing`), name, `state · current-tool` (activity snapshots, ticket `01`), state age on the right.
   - Header counts **active** = {active, starting, running, blocked} vs **open** = the rest still tracked; **amber border when active = 0** — the "your fleet is idle, look up" signal.
   - **Rows leave on delivery** (or suppression for interactive runs) — the table is in-flight work only, not a morgue.
2. **Kept from v0.5-05 (ours were better):**
   - **Blocked callout** — blocked rows additionally trigger the inverse callout beneath the table with the question preview; blocked stays the widget's one loud alarm (prior art merely counts it as active).
   - **Footer replacement** — the widget displaces the footer agent count; footer = diagnostics only.
   - **Read-only** — no affordances, ever; "go look" = focus the pane.
3. **Child-side identity/tools strip** rides the substrate (ticket `01`): `[scout] — 12 tools · 4 denied (Ctrl+J)` above the child's editor.
4. **Data plumbing:** one poll loop, many consumers — the same watcher that feeds push delivery (ticket `02`) and status projection (ticket `03`) feeds the widget; no separate polling tier.
