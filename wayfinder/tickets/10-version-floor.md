---
label: wayfinder:grilling
status: closed
assignee: Andrew
blocked-by: []
---

## Question

Which herdr versions pi-herdr supports, and what legacy code the floor deletes. The user's ruling: drop older branches, implement against the latest only.

## Resolution

Facts established 2026-09-19: **herdr v0.9.0 (2026-09-07) is current stable** — the release that fixed Windows `agent start --kind` (Powerwell shim launch + flaky process-tree detection; already validated e2e by our `tests/win-start.mjs`).

1. **Floor: herdr ≥ 0.9.0, hard.** Init probes the version once; below 0.9.0 → one clean `HERDR_TOO_OLD` error with the upgrade pointer (same style as `HERDR_UNAVAILABLE`). No partial function, no degraded paths, no per-feature negotiation.
2. **Deleted outright:**
   - the 0.7.3 legacy API branch (`version.ts` + call sites);
   - the Windows 0.7.5–0.8.x `pane run` + auto-detect fallback (`spawn.ts`);
   - the 0.8.2 `agent_not_ready` / state-self-report workarounds.
   One launch path remains: `agent start --kind pi --pane <id> -- <argv>` on every OS.
3. **Kept:**
   - the **version probe itself** — diagnostics + footer readout (herdr ships fast: 0.7.5→0.9.0 was two months; knowing the version stays cheap);
   - **self-report** (`src/selfreport.ts`) — orthogonal insurance (herdr can miss working→idle even on 0.9), not a version workaround; it also gains the substrate duties (ticket `01`).
4. **README:** platform support collapses to "requires herdr ≥ 0.9.0" + the macOS launchd PATH note (ours, not herdr's). The Windows 0.7.5–0.8.x platform-notes forest is deleted with the code.
5. **Not a decision, recorded for later:** 0.9's headline is multi-machine herdr (agents on remote boxes in one TUI) — a natural future home for spawn-a-remote-agent; the map keeps it out of scope for v0.6 and nothing in the spec depends on it.
