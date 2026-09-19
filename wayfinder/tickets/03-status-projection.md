---
label: wayfinder:grilling
status: closed
assignee: Andrew
blocked-by: [01-substrate]
---

## Question

The status vocabulary and the machinery that derives it. Replaces the v0.5 six-state model (`queued/working/idle/done/blocked/gone`) with the richer projected vocabulary adopted from prior art (research/richardh-prior-art.md §4) — adopted because expressiveness was the user's explicit call, and because the substrate (ticket `01`) makes the richer states *honest* rather than guessed.

## Resolution

1. **Ten states, three sources.** States are *derived*, never stored as ground truth:

| State | Meaning | Source |
|---|---|---|
| `queued` | accepted, no pane yet (parallel cap) | spawn registry |
| `starting` | launched, pane/activity settling | herdr + snapshots |
| `active` | processing (turn, provider, streaming, tool) — enriched `active · bash 7m` | herdr + snapshots |
| `waiting` | settled, pane intentionally open (interactive / mid-conversation) | herdr + registry |
| `blocked` | child asking a question | herdr + self-report |
| `interrupted` | turn cancelled, pane still open | ticket `06` |
| `stalled` | inspection unhealthy / pane gone without sidecar | watchdog |
| `running` | coarse fallback — snapshots unavailable (non-pi passthrough panes) | herdr only |
| `finalizing` | completion observed, push in flight | sidecar watcher |
| `gone` | pane vanished, terminal — registry metadata + retained session survive | registry |

1. **The three inputs:**
   - **herdr pane inspection** — coarse authority: process present? idle/working/blocked?
   - **Child activity snapshots** — the injected recorder (ticket `01`) reports the current tool/streaming state; this is what makes the `active` detail real.
   - **Watchdog** — flags `stalled` when inspection is unhealthy or a pane vanished without a completion sidecar; **valid long-running `active`/`waiting` never becomes `stalled` merely by aging**. On stall-entry and stall-recovery, the orchestrator receives a steer ping.
2. **Interactive/autonomous split governs pings.** Autonomous agents (auto-exit stance) ping the orchestrator on stall/recover; interactive ones (user-driven pane) stay widget-only — a steer there burns an orchestrator turn on a no-op. The split derives from `auto-exit` (inverse default), overridable per-agent (`interactive: true|false` frontmatter) and per-spawn.
3. **Widget consumption** (ticket `07`): header counts `active` = {active, starting, running, blocked}; `open` = the rest still tracked. Amber border when active = 0. Terminal-after-push rows leave the table.
4. **`get_agent_result` reports the projected state** honestly, with `gone` = valid terminal answer + last-known metadata (v0.5-10 ruling carried forward).
5. **Honesty mapping note.** Old → new: `working` → `active`/`running`; `idle` → `waiting` (semantics shift: "open and intentionally so"); `done` → `finalizing` → delivered (registry marks consumed). `waiting` is only claimable because of sources 2–3 — that is why the vocabulary and the machinery are one package.

**Feeds:** `07` (widget renders these states), `02` (delivery events drive `finalizing`/terminal), `06` (`interrupted`).
