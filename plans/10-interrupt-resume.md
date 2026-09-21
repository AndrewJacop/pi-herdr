# Plan — v0.6 issue 10: Interrupt + resume

## Context

Issue [10-interrupt-resume](.scratch/v0.6/issues/10-interrupt-resume.md) (decided by [wayfinder/tickets/06-interrupt-resume.md](wayfinder/tickets/06-interrupt-resume.md), prior art research §7). Two lifecycle actions:

- **`herdr_interrupt_agent(target)`** — turn-level cancel: Escape to the child pane, state flips to `interrupted` **immediately** (flag-driven, not on next poll), stale pre-interrupt activity snapshots discarded so a lagging read can't overwrite the interrupt; new work returns it to `active` naturally. Composes with `herdr_message_agent` as stop-and-redirect. Pi-only — non-pi panes refused honestly. A turn cancel, not a terminate (kill-all stays the menu action).
- **`herdr_resume_agent(target, message?)`** — target is a **registry handle, never a raw path**; the registry holds the retained session file. Relaunches `pi --session <retained>` in a fresh pane with a **re-derived launch plan** (definition's kind/model/thinking resolved *now* via the 08 chain), optional `message` as the opening prompt, and re-entry into normal supervision (widget row, watchdog, push-on-completion). Same gates as any spawn (kill-switch → depth → cap). Stance follows the definition. Resume-on-`gone` is the documented recovery move. Honest limit: resume replays the session file — anything that lived only in the dead process is gone (pi-herdr owns the file from boot, so that's the whole truth).

All three blockers are landed: 04 (substrate, 2a51f5a), 07 (projection + `interrupted` reserved, 17b9a81), 08 (launch plan + routing chain, 3730aae).

## What already exists (reuse)

| Piece | Where |
|---|---|
| `interrupted` reserved in the projection (obs flag, settled branch) | `src/status.ts` (`ProjectionObs.interrupted`, priority last in settled branch) |
| Escape-send machinery (`pane send-keys <id> esc` argv) | `src/tools/sync.ts` herdr_send_keys — same `herdr()` call, engine reuses the argv shape |
| Registry (`spawnRecords()`), gates (`checkGates`), launch path (`startRecordNow`), spec merge/routing/argv builders, stance | `src/spawn.ts` (all exported), `src/launchplan.ts` |
| Routing chain + validation resolved *now* (`resolveRouting`, `validateRouting`) | `src/launchplan.ts` |
| Engine-with-injectable-seams + thin registration pattern | `src/tools/message.ts` (the model for the new module) |
| Abort-settle handling already child-side: `stopReason: "aborted"` never auto-exits, no sidecar on abort | `src/child.ts` (`shouldAutoExitOnSettle`) — why interrupt + autonomous stance already composes |
| Sidecar paths + steer watermark | `src/sessionfile.ts` |
| Offline harness (jiti, injected deps), live round-trip pattern | `tests/message.mjs`, `tests/push-live.mjs` |
| Tracked-panes + `finally` cleanup pattern (`cleanupPanes(tracked)`) | `tests/push-live.mjs` (lines ~104, ~325) |

## Approach

### 1. Interrupt — projection wiring (`src/status.ts`)

- `SpawnRecord` + `ProjectableRecord` gain `interruptedAt?: number` (ms epoch, parent-stamped).
- `projectStatus` derives the state from **`record.interruptedAt !== undefined`** — the reserved `obs.interrupted` flag is replaced (issue 10 claims the seam; the only caller set is tests/status.mjs's pin, updated accordingly).
- New precedence: after the `absent`/`blocked` checks (the ticket's own semantics: *"turn cancelled, **pane still open**"* — absence still means `stalled`), and **before** the `unhealthy`/`working`/settled branches — so the flip is immediate even while herdr still reports the child `working`.
- **Stale-snapshot discard**: while `interruptedAt` is set, an activity snapshot with `updatedAt <= interruptedAt` is discarded (treated as missing) — a lagging pre-interrupt reading can't show `active · bash 7m`. The child's own post-abort settle-write (phase `waiting`, fresh timestamp) does *not* clear the state (the abort-settle is not new work).

Clearing the flag (new work returns it to `active` naturally):
- `messageAgent` (`src/tools/message.ts`): when the resolved target has a registry record, clear `record.interruptedAt` right before sending — the stop-and-redirect composition in one live flow.
- The **projection self-corrects** on the first fresh phase-active snapshot (no delivery-loop write needed — the `deliverOnce` clearing listed below became redundant and was dropped during execution; the pure projection covers the human-typed-work case).

Known cosmetic: for ~1s after stop-and-redirect the row may show `active · bash <stale age>` until the child's fresh `runStarted` write lands. Accepted.

### 2. Interrupt — engine (`src/tools/lifecycle.ts`, new)

Engine + registration for both tools, mirroring message.ts (injectable seams: `registry`, `agentGet`, `sendKeys`, `status`, `now`, `signal`; defaults hit herdr).

`herdr_interrupt_agent(target)`:
1. Resolve: registry handle → else `agent get` (reuse message.ts's `defaultAgentGet`, exported) → pane-id/name → registry record by pane. No record → `NOT_FOUND` pointing at `herdr_send_keys` (raw escape) and `herdr_list_agents` — the projection wiring only exists for our records, so that *is* the honest scope.
2. Refusals, each honest and actionable: non-pi kind (`VALIDATION_ERROR` — turn-cancel via Escape is the pi TUI promise; non-pi panes can be escaped with `herdr_send_keys`); queued/never-started; pane gone → `NOT_FOUND` pointing at **`herdr_resume_agent`** (the recovery move); pane settled (`idle`/`done`) → nothing to cancel. `blocked` is interruptible (Escape dismisses the overlay — abandoning the question *is* a turn cancel).
3. Send Escape: `herdr pane send-keys <paneId> esc`.
4. Stamp `record.interruptedAt = now()`; receipt `{name, target, state: "interrupted"}`.

### 3. Resume — spawn.ts changes (small)

- `SpawnRecord` gains `definition?: SpawnSpec` (stamped at spawn — the merged spec object, zero copy cost) and `resumeSilent?: boolean`.
- `startRecordNow` adjustments:
  - Worktree step: skip creation when `record.worktreePath` already exists (isolated resume keeps its worktree; `cwd = worktreePath ?? cwd`).
  - `resumeSilent` path: skip prompt submission *and* the post-submit idle-error check (idle is the expected end state of a message-less boot — the child replays and sits open).
- `buildTaskPrompt`/steer watermark keep working unchanged (they read `record.prompt`).

### 4. Resume — engine (`src/tools/lifecycle.ts`)

`herdr_resume_agent(target, message?)`:
1. Target must be a registry handle (raw path → explicit refusal). Record must exist and be a substrate child (`sessionPath` + kind pi) — non-pi records have nothing to replay.
2. Pane state: must be **absent from the live fleet** (the gone recovery move). Live pane → "interrupt or message instead"; queued → "still queued".
3. **Re-derive the launch plan now**: definition = `resolveSpecifier(record.type)` (re-reads `.md` — fresh edits apply), falling back to `record.definition` when `type` is unset/unresolvable (anonymous inline spawns stay resumable); re-run `resolveRouting` against **current** settings/parent/registry → `validateRouting` + `validateKindEnforcement` → rebuild `buildAgentArgs` (same handle's identity block) → `materializeAgentArgs` → `record.agentArgs`; re-derive stance (`deriveStance`). Kind guard: the re-derived kind must be pi — the retained file is a pi session (`--session` is pi-only); a changed `default_kind` refuses naming it.
4. **Same gates, in order** via `checkGates` (kill-switch → depth → cap). Over-cap **with** a message → queue (clear `paneId`/`startError`; the drain starts it when a slot frees). Over-cap **without** a message → also queueable: `record.resumeSilent = true` rides the record into the drain's `startRecordNow`.
5. Reset transient state: `submitted`/`sawWorking` false, `startError`/`goneAt`/`watch`/`delivery`/`blockedNotified`/`takenOver`/`tookNotified`/`interruptedAt`/`lastStatus` cleared, `paneId` cleared (fresh pane replaces), `record.prompt = message ?? record.prompt`.
6. **Clear stale sidecars before relaunch** (new `clearSidecars(sessionPath)` in sessionfile.ts, best-effort unlinks): `<session>.exit` (critical — an old completion sidecar would be re-delivered instantly as the resumed run's result), `<session>.takeover` (would suppress blocked wakes), `<session>.activity.json` (stale phase). The steer watermark is left — `submitRecordPrompt` re-stamps it.
7. `startRecordNow(record, deps)` → fresh paneId, boot gate, optional message submitted (watermark + task artifact ride the existing machinery). New supervision re-entry is automatic: the registry record drives the widget row, watchdog, and push-on-completion.
8. Result data mirrors spawn's: `{name, status|queued, paneId?, sessionPath, stance, model, thinking}`.

Docs honesty: resume replays the session file; nothing that lived only in the dead process survives. Autonomous + no message = the child replays and sits idle (no new turn to settle) — fine for handing the pane to a human; pass a message to give it work.

### 5. Registration + docs

- `src/index.ts`: `registerLifecycle(pi)` (both tools; count goes 9 → 11).
- README: two tool-table rows + a short "Interrupt and resume" subsection (stop-and-redirect; resume-on-`gone` as the recovery move; the honest replay limit); CHANGELOG (Added).

## Files to modify

- `src/status.ts` — `interruptedAt` on record types; flag-driven `interrupted` precedence; stale-snapshot discard; `ProjectionObs.interrupted` removed
- `src/spawn.ts` — `definition`/`resumeSilent` record fields; stamp `definition` at spawn; `startRecordNow` worktree-skip + silent path
- `src/sessionfile.ts` — `clearSidecars(sessionPath)`
- `src/tools/message.ts` — export `defaultAgentGet`; clear `interruptedAt` on record delivery
- `src/tools/lifecycle.ts` — **new**: interrupt + resume engines (injectable seams) + both registrations
- `src/delivery.ts` — dropped during execution: projection self-correction covers it (no edit needed)
- `src/index.ts` — registration
- `tests/status.mjs` — updated `interrupted` pin (record field instead of obs flag) + new derivation cases
- `tests/lifecycle.mjs` — **new** offline suite (+ `npm test`)
- `tests/lifecycle-live.mjs` — **new** live suite (+ `test:live`); tracked-panes/`finally` cleanup, ≤2 concurrent children
- `README.md`, `CHANGELOG.md`

## Steps

- [x] 1. Red: `tests/status.mjs` new pins — interrupted beats `working`/`unhealthy`/settled immediately; stale snapshot (updatedAt ≤ interruptedAt) discarded; absent still wins; fresh-active clears (delivery)
- [x] 2. Green: `src/status.ts` precedence + discard; `src/tools/message.ts` clear-on-send (the planned `delivery.ts` clear became redundant — projection self-correction covers it)
- [x] 3. Red: `tests/lifecycle.mjs` interrupt sections — resolution chain, refusals (non-pi, queued, gone→resume pointer, settled), happy path stamps `interruptedAt`, message composition clears it
- [x] 4. Green: interrupt engine in `src/tools/lifecycle.ts`
- [x] 5. Red: resume sections — gone→relaunch (same sessionPath, new paneId, transients reset, sidecars cleared), routing re-resolves now (settings/parent change between death and resume lands in the new launch plan), definition fallback, kind-change refusal, raw-path/live/queued refusals, gates (kill-switch, depth, cap→queue incl. silent), `resumeSilent` skips submit
- [x] 6. Green: resume engine + `src/spawn.ts` (`definition`/`resumeSilent`, `startRecordNow` changes) + `src/sessionfile.ts` `clearSidecars`
- [x] 7. Wire registrations (`src/index.ts`); `node tests/lifecycle.mjs` green, `npm run typecheck` clean, full `npm test`
- [x] 8. `tests/lifecycle-live.mjs`: interrupt→stop-and-redirect (working child → escape → `interrupted` row → message → active → completes) and one crash→`gone`→resume→push round-trip; run against a live herdr session. **Pane hygiene (user rule, pinned in the test):** every opened pane id goes into a tracked list and a `finally` block closes them all (push-live.mjs's `cleanupPanes` pattern) — no panes left hanging. **Concurrency cap (user rule):** scenarios run strictly sequentially, never more than 2 child agents live beside the orchestrator (test settings pin `max_parallel_agents: 2`); the resume round-trip starts only after the interrupt scenario's child is closed.
- [x] 9. README + CHANGELOG
- [x] 10. `/code-review` the work; fix findings
- [x] 11. Commit to the current branch

## Verification

1. `npm run typecheck`; `node tests/lifecycle.mjs` + full `npm test`
2. `node tests/lifecycle-live.mjs` with a running herdr session (~5 min): stop-and-redirect composition + gone→resume→push round-trip
3. Manual: spawn an autonomous child, interrupt it (`interrupted` in `herdr_list_agents` immediately), message it (back to `active`), close its pane, `herdr_resume_agent` with a message → completion push arrives; settings `models.default` changed between death and resume visibly relaunches on the new model

## Decisions taken in this plan (deny-with-feedback if you disagree)

- **Interrupt scope = registry records only.** The value over raw `herdr_send_keys esc` is the projection wiring, which only exists for our records; adopted panes are pointed at `herdr_send_keys` honestly.
- **`obs.interrupted` (the reserved seam) is replaced by `record.interruptedAt`.** One input instead of a caller-computed flag + record timestamp that could desync; issue 10 was always its consumer.
- **Resume exposes no model/thinking/kind overrides** — the ticket's letter: the definition's values re-resolved *now* (settings/parent/registry), not new pins.
- **Over-cap resume queues** (same gates as spawn) — with a message via the normal drain; without one via `record.resumeSilent`, so the drain doesn't resubmit the dead run's task.
- **A just-interrupted pane that vanishes reports `stalled`** (absence outranks the flag — the ticket's own "pane still open" wording); the delivery pass resolves the terminal answer.
