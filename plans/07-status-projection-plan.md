# Plan — Issue 07: Status projection + watchdog

## Context

`D:/Me/pi-herdr`, v0.6 issue 07. Blocked-by tickets 04 (substrate: sessionPath/activityPath stamped, `PI_HERDR_ACTIVITY_FILE` env already handed to children) and 06 (delivery loop: `record.delivery` marks consumed terminal events) are landed. The ten projected states are **derived, never stored**; sources: herdr pane inspection (coarse), child activity snapshots (new recorder duty), and a watchdog.

Prior art studied: `.scratch/pi-herdr-subagents/pi-extension/subagents/activity.ts` + `status.ts` (60s stall threshold, `s/m/h m` age format, stall-entry/recovery transitions).

## Seams (pre-agreed, per the issue's acceptance criteria)

1. **`src/status.ts`** (new) — pure projection: `PROJECTED_STATES`, `ActivitySnapshot`, `readActivityFile()`, `formatAge()`, `projectStatus(record, obs)`. Offline-tested with a fake pane-inspection source.
2. **`src/child.ts`** — activity recorder: writes the activity sidecar (`<session>.activity.json`) on pi events (`session_start`→starting, `agent_start`→active, `tool_execution_start/end`→tool, `message_update`→streaming, `agent_settled`→waiting), throttled 500ms for streaming. Powers `active · bash 7m`.
3. **`src/delivery.ts`** — `watchdogOnce()` sharing the tick's single fleet observation: pane vanished without sidecar → `stalled` (ping once on entry, ping on recovery, **autonomous stance only**); snapshot problem held ≥60s → `stalled`. Aged-but-valid `active`/`waiting` never stalls (no rule references their age).
4. **`src/tools/result.ts`** — interim statuses speak the projected vocabulary per the honesty mapping: `working`→`active`(+detail)/`running`, `idle`→`waiting`/`starting`; terminal answers (`done`/`error`/`gone`) unchanged; `gone` keeps last-known metadata.
5. **`src/tools/orchestration.ts`** — `herdr_list_agents` joins the registry: projected state for our records (incl. `queued` rows from the parallel-cap queue), coarse status for adopted panes, delivered rows leave the table.

## Projection precedence (status.ts doc comment)

1. `startError` → `gone`
2. no pane → `queued`
3. `record.delivery` (consumed) → pane present? `waiting` : `gone`
4. completion sidecar ok, delivery pending → `finalizing`
5. pane absent, no sidecar → `stalled` (watchdog grace; delivery resolves)
6. herdr `blocked` → `blocked`
7. transient inspection failure → `stalled` after 60s, else last-known coarse
8. herdr `working`: activity `active`→`active`+detail; snapshot problem ≥60s→`stalled`, else coarse `active`; non-pi → `running`
9. settled (`idle`/`done`/`unknown`): activity fresher-than-herdr `active` wins; pre-submit → `starting`; reserved `interrupted` flag (issue 10); else `waiting`
10. aged-but-valid `active`/`waiting` never stalls by aging.

## TDD slices (red → green each, all in `tests/status.mjs`)

- **[1]** reader + `formatAge` worked examples + all ten states against fake inputs
- **[2]** recorder: mock-pi event drive → real sidecar file on disk; throttling
- **[3]** watchdog: stall-entry/recovery pings, interactive suppression, aged-valid never stalls
- **[4]** `getAgentResult` interim vocabulary + detail; `gone`-with-metadata kept
- **[5]** `listAgentsView` rows: projected / coarse-adopted / queued / gone; delivered rows skipped

Then: `npm run typecheck`, add `tests/status.mjs` to `package.json` `test`, full offline suite, live spawn→status round-trip if a herdr session is available. `/code-review`, then commit to the current branch.

## Out of scope

- `interrupted` production (issue 10 — reserved, vacuously derivable)
- The fleet widget rendering (issue 11)
- `SpawnStatus` in spawn.ts (spawn tool's wait vocabulary — not named by the issue)
