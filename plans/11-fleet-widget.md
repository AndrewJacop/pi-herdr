# Plan — v0.6 issue 11: the fleet widget

## Context

Issue [11-fleet-widget](.scratch/v0.6/issues/11-fleet-widget.md) (decided by [wayfinder/tickets/07-widget.md](wayfinder/tickets/07-widget.md), prior art research §8). The orchestrator's ambient view: one row per in-flight agent — process elapsed (`MM:SS`, freezing at `finalizing`), name, `state · current-tool`, state age on the right — under a `Subagents ─ N active · M open` header with an **amber border when active = 0**. Rows leave on delivery (the table is in-flight work only). Kept v0.5 amendments: the **blocked callout** beneath the table with the question preview (the one loud alarm), **footer replacement** (footer = diagnostics + version tag only), **read-only** (no affordances ever). **No separate polling tier** — the widget consumes the same watcher tick that feeds push delivery (06) and the watchdog (07).

Both blockers are landed: 06 (delivery loop, f6c176f), 07 (projection + activity detail, 17b9a81).

## What already exists (reuse)

| Piece | Where |
|---|---|
| Ten-state projection (`projectStatus`, `ProjectionObs`) | `src/status.ts` |
| `formatAge` (`45s` / `7m` / `2h 5m`) + `activeDetail` (`bash 7m`) | `src/status.ts` |
| The shared tick (one `fleetList()` per pass, deliver + watchdog) | `src/delivery.ts` `registerDelivery` |
| Registry (`spawnRecords()`), `SpawnRecord` (stance, spawnedAt, delivery mark) | `src/spawn.ts` |
| Sidecar/activity/session-extraction seams | `src/sessionfile.ts` |
| Projection assembly pattern (sidecarOk + live/absent per record) | `src/tools/orchestration.ts` `listAgentsView` |
| Widget API (`ctx.ui.setWidget(key, lines \| factory)`, `ctx.ui.theme`) | pi `ExtensionUIContext` (child.ts `renderStrip` is the in-repo example) |
| Offline harness (jiti, injected deps) | `tests/status.mjs`, `tests/delivery.mjs` |

## Approach

### 1. `src/widget.ts` (new)

- **Pure formatting** (unit-tested): `formatElapsed(ms)` → `MM:SS` (minutes may exceed 59); `ACTIVE_STATES` = {active, starting, running, blocked}; counts + `idle` flag (active = 0); `renderWidgetLines(model, width, style?)` → string[] with a `style` adapter (`border/dim/inverse/plain`) defaulting to a no-op style, so tests pin layout and the pi glue passes theme colors. Box: `╭─ Subagents ───── N active · M open ─╮`, rows `│ MM:SS  name  state · tool  age │` (age right-aligned, dim), blocked callout line(s) beneath the box: inverse `⚠ name BLOCKED` + age + `"preview…"`.
- **Model assembly** (pure-ish, tested with a fresh cache): `buildWidgetModel(records, obsOf, now, cache)` — projects each record (same `ProjectionObs` assembly as `listAgentsView`), skips `delivery`-marked records, computes per row: elapsed = `startedAt ?? spawnedAt` (frozen at `finalizing` via the cache stamp), state age = snapshot `activeSince`/`waitingSince` → `queued`/`starting` = since `spawnedAt` → `interrupted` = since `interruptedAt` → `stalled` = since `watch.problemSince` → else first-seen cache keyed by name (state episodes). Blocked pi children get `blockedPreview` = first non-empty line of the session's last assistant message, ellipsis-truncated.
- **`fleetWidgetOnce(deps)`** — one tick: empty registry → clear the widget once (and reset caches); else build the model and `setWidget(key, factory)` where the factory renders at the real terminal width with `ctx.ui.theme` colors. Injectable seams (registry, fleet, sidecar/activity/extract reads, now, ui sink) mirror the delivery/watchdog pattern. Cache entries for vanished records are GC'd.
- **`registerFleetWidget(pi)`** — captures `ctx.ui` (TUI/RPC only) on `session_start`, clears it on `session_shutdown`. Read-only: no shortcuts, no hints.

### 2. `src/delivery.ts` — same watcher, third consumer

The tick keeps ONE fleet observation and adds the widget pass after deliver + watchdog; an empty-registry tick clears the widget instead of returning bare (so the widget can't outlive its fleet):

```ts
if (spawnRecords().size === 0) { fleetWidgetOnce({ fleet: { ok: true, data: [] } }); return; }
const fleet = await fleetList();
await deliverOnce({ push, fleet });
await watchdogOnce({ push, fleet });
await fleetWidgetOnce({ fleet });
```

### 3. `src/index.ts` — footer reduced to diagnostics

The `updateStatus` closure dies — it was its own polling tier (`herdr agent list` on every agent_start/turn_end) and duplicated the agent count the widget now carries. The footer is set once per session from the version probe (already fetched in the `session_start` handler): `herdr: not installed — herdr.dev` / `herdr: version unknown — needs ≥ X` / `herdr: too old (X < Y)` / `herdr vX.Y.Z`.

### 4. Tests + docs

`tests/widget.mjs` (offline, jiti, injected seams): elapsed format; active/open counts + idle flag; row layout + right-aligned age + truncation; amber border when active = 0; elapsed freeze at finalizing; rows leave on delivery; blocked callout + question preview; state ages from snapshots vs first-seen cache; coarse `running` for non-pi; empty fleet clears once. Added to `npm test`. CHANGELOG entry; README footer mentions updated (the old `herdr: 3 agents (1 working) (0.9.0)` examples).

## Review fixes (two-axis review, applied)

- **All-delivered shell (spec, worst):** the registry never shrinks, so the empty-registry clear could never fire post-delivery — a permanent `0 active · 0 open` amber shell sat above the editor. `fleetWidgetOnce` now clears on an empty ROWS view (all records delivered), exactly like an empty registry.
- **Elapsed freeze vs blips (spec):** the freeze was stamped into a per-episode cache entry that a transient state flip replaced wholesale. The freeze now carries `frozenFor` (the `startedAt` it was measured against) across episode resets — blips keep it, a resume (fresh `startedAt`) recomputes.
- **Callout ANSI split (spec):** the final `hardFit` sliced styled text by raw index; every callout piece is now pre-fitted to a width-derived budget instead, so the composed line never needs a raw cut.
- **`readActivity` twice per record per tick** (standards): read once, pass to both the projection and the age lookup.
- **UI-less sessions paid disk I/O** for a widget they can't show: the sink check moved ahead of every read.
- **Dead `style.plain`**, **fabricated fleet in the empty-registry tick**, **`tui: never`** → removed / honest `fleetWidgetOnce()` / `unknown`.
- **Unmaintainable box math:** layout constants named/commented; `c.left.slice(7)` replaced by carrying the row name.
- `docs/development.md` smoke count 167 → 175.

Judgement calls left as-is (documented in the review): the pairwise `records`/`projections` arrays (the test-pinned contract), the `fit`/`hardFit` pair (plain vs ANSI-aware metrics), the delivery filter inside `buildWidgetModel` (unit-tested at the model level even though production pre-filters), and the `setStatus`-before-`hasUI` guard (footer is RPC-visible by design, matching the old behavior; only dialogs are TUI-gated).
