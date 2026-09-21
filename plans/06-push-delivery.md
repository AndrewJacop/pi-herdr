# Plan — v0.6 issue 06: Push delivery + user takeover + idle re-arm

## Context

Issue [06-push-delivery](.scratch/v0.6/issues/06-push-delivery.md) (decided by [wayfinder/tickets/02-push-delivery.md](wayfinder/tickets/02-push-delivery.md)): when a child finishes, the **full final assistant message** must be steered into the orchestrator session — the push carries the letter, no doorbell, no summary-then-fetch. Wake is governed by the existing `notifications` setting; **blocked always wakes**. Both completion routes (auto-settle sidecar, declared `agent_done`) push; detection is triply redundant (sidecar > sentinel > pane-disappearance with bounded grace). **User takeover** (human typing in a child pane) splits two effects: auto-exit is disabled, the result contract is never revoked; the orchestrator gets a quiet `user took over <agent>` note; no mid-conversation pushes land from a taken-over pane. **Idle re-arm**: after takeover + settle + `idle_rearm_minutes` (default 15) of quiet → the latest final message is auto-delivered labeled *auto-delivered after user steer*, the pane closes, the session is retained; any keystroke resets the timer (timer starts on `agent_settled`, never mid-work). `herdr_get_agent_result` stays pure inspection. **One shared poll loop** drives detection; tickets 07/11 hang off it later.

## What already exists (reuse)

| Piece | Where |
|---|---|
| Push primitive: `pi.sendMessage(msg, {triggerTurn, deliverAs})` — `deliverAs: "steer"|"nextTurn"`, `triggerTurn` = wake | pi ExtensionAPI (docs/extensions.md §sendMessage); prior art uses `{triggerTurn: true, deliverAs: "steer"}` |
| Settings `notifications: none|quiet|normal`, `idle_rearm_minutes` (default 15) | `src/settings.ts` (already in SETTING_KEYS + DEFAULT_SETTINGS) |
| Typed completion sidecar read/write, JSONL exact-last-assistant extraction, error mining | `src/sessionfile.ts` (`readExitSidecar`, `extractSessionResult`, `minedAssistantError`, `sidecarPathFor`) |
| Child extension: `agent_done`, auto-exit on `agent_settled`, error-exit grace, `input` event already cancels error-exit | `src/child.ts` |
| Spawn registry (name→record; sessionPath/activityPath/stance/lastStatus), drain-loop pattern (self-scheduling unref'd timer) | `src/spawn.ts` |
| Live status (`herdr agent get` → agent_status; NOT_FOUND/agent_not_found codes) | `src/tools/orchestration.ts` (`getAgentStatus`) |
| Sidecar-race-on-gone pattern (sidecar wins over gone; mined-error-from-JSONL fallback) | `src/tools/result.ts` `inspectRecord` |
| Offline test harness (jiti imports, mock pi, injected deps) + live round-trip pattern | `tests/substrate.mjs`, `tests/spawn-live.mjs` |

## Approach

### 1. The delivery loop — new `src/delivery.ts`

Registered from `src/index.ts` (needs `pi` to steer its own session). A self-scheduled `setInterval` (~2.5s, `unref`'d, same discipline as spawn's drain loop) running `deliverOnce(deps)`; no-op when the registry has nothing to watch.

Per tick, for each registry record not yet delivered:
- **One fleet observation per tick** (`herdr agent list` → paneId→status map) instead of per-record `agent get`.
- **Detection, in priority order (triply redundant):**
  1. **Exit sidecar** (pi children): `readExitSidecar(sessionPath)` ok → terminal `done`/`error` (exact result from `extractSessionResult`). Sidecar `rearm:true` (see §3) → labeled delivery.
  2. **Sentinel — sidecar-less death**: the agent vanished from the fleet (`agent_not_found`/NOT_FOUND) with no sidecar → **bounded grace** (`GONE_GRACE_MS`, 10s; injectable): keep re-racing sidecar/JSONL during the window (a dying auto-exit writes its sidecar just before shutdown), then resolve at expiry by best evidence: sidecar → typed terminal; else the JSONL's last assistant message = the delivered letter (typed error if `minedAssistantError`, else the text) — the sentinel, a death the sidecar missed; else an honest gone note. First absence stamps `record.goneAt` so grace is measurable; a reappear clears it.
  3. **Pane-disappearance** (pane itself closed by a human, nothing on disk): the same absence path lands on the gone note — session retained, last-known registry metadata, quiet delivery.
  - Transient herdr errors are not absence evidence: keep the last-known view, never false-gone.
- **Blocked always wakes**: live-status transition → `blocked` (and not taken over) → wake push regardless of `notifications`.
- **Each terminal event pushes exactly once** — `record.delivery = {state, kind, at}` dedupes (inline `wait:true`, pulls, and the push all observe the same terminal; only one push).
- Deferred (queued) start failures (`record.startError` set after the spawn tool returned `queued`) ride the same path as a typed failure push.

**Push composition** — custom message steered into the orchestrator:
- `notifications: "normal"` → `{triggerTurn: true, deliverAs: "steer"}` (wake).
- `notifications: "quiet"` → `{triggerTurn: false, deliverAs: "nextTurn"}` (next natural turn, no wake).
- `notifications: "none"` → **no completion push at all** (pull-only; result still in the registry + JSONL, blocked still always wakes). *(decided 2026-09-20)*
- blocked → always `{triggerTurn: true, deliverAs: "steer"}` regardless of setting.
- **pi children only**: non-pi kinds have no session substrate — they stay pull + coarse statuses, no completion pushes. *(decided 2026-09-20)*
- Content carries the **full final message** (never truncated): `Agent "<name>" finished — full final message:\n\n<exact text>` (+ session path resume pointer); errors: `Agent "<name>" FAILED: <errorMessage>`; re-arm: prefixed `auto-delivered after user steer:`.

All evidence sources + the push sink are injected (`DeliveryDeps`), so offline tests drive `deliverOnce` against fake registries/clocks/captures and assert **the steer call's flags** (the offline-verifiable wake contract).

### 2. User takeover — child-side input reporting

- Child extension keeps a `takenOver` flag set on `pi.on("input")`.
- **Orchestrator-echo problem (decided: steer watermark)**: herdr's `agent prompt` types into the pane through the same TTY as a human — indistinguishable at pi's `input` event. Before steering a registry child, the parent stamps a `<session>.steer` watermark file carrying the exact text (spawn's initial submit in `startRecordNow`; `message_agent` in `src/tools/message.ts`). The child marks takeover only for input events whose text is **not** part of a current watermark (watermark consumed on match). The spawn's own initial prompt therefore never counts as takeover either.
  - `herdr_send_keys` needs no watermark: it sends logical key names (ctrl+c/esc/Enter), which drive overlays, not editor text input.
- On takeover: child writes a `<session>.takeover` marker once; parent loop sees it → sends the quiet note (`user took over <agent>`, `{triggerTurn: false, deliverAs: "nextTurn"}`) once, sets `record.takenOver`, suppresses blocked-wakes and all mid-conversation pushes for that record.
- Result contract never revoked: `agent_done` untouched; session file readable throughout.

### 3. Idle re-arm — child-side timer

- Parent stamps `PI_HERDR_IDLE_REARM_MS` (settings `idle_rearm_minutes` × 60_000) into the child env at start; child reads it per-settle (env-overridable for tests), like `errorExitGraceMs`.
- On `agent_settled` with `takenOver`: no immediate exit — schedule the re-arm timer (N quiet ms). Any input cancels it; the next settle restarts it ("timer starts on `agent_settled`, never mid-work").
- Timer fires → write sidecar `{type:"done", rearm:true}` (or `error` + `rearm:true`) → `ctx.shutdown()`. Pane closes, session retained.
- Error-settle grace (30s auto-exit) is suppressed while taken over — a pane never slams shut on a human; the re-arm window governs instead.
- `parseExitSidecar` grows an optional `rearm` field (tolerant, back-compatible); parent labels the delivery from `sidecar.rearm || record.takenOver`.

### 4. Tool surface

No new tools, no param changes. `herdr_get_agent_result` untouched (pure inspection). Registry record grows `takenOver?/tookNotified?/delivery?/goneAt?` (07 consumes `delivery` for rows-leave-on-delivery).

## Files to modify

- **NEW** `src/delivery.ts` — poll loop, triply-redundant detection, push composition + wake flags, quiet takeover note.
- `src/child.ts` — takeover flag + `<session>.takeover` marker, re-arm scheduling, `PI_HERDR_IDLE_REARM_MS`, sidecar `rearm` flag, error-grace suppression under takeover.
- `src/sessionfile.ts` — takeover/steer marker path helpers + readers; `parseExitSidecar` optional `rearm`.
- `src/spawn.ts` — stamp `PI_HERDR_IDLE_REARM_MS`; steer watermark on the initial submit; new registry fields.
- `src/tools/message.ts` — steer watermark when message_agent steers a registry child.
- `src/index.ts` — register the delivery loop.
- `README.md` / `CHANGELOG.md` — push/takeover/re-arm behavior + settings semantics.
- `.scratch/v0.6/issues/06-push-delivery.md` — tick acceptance boxes.

## Tests (TDD at the seams: `deliverOnce`, `parseExitSidecar`, child `registerChildExtension`)

- **NEW** `tests/delivery.mjs` (offline, added to `npm test`):
  - red-green for the three detection routes (fake sidecar/status/JSONL evidence + fake clock): sidecar wins; sentinel (agent-gone) races sidecar then delivers JSONL letter (typed error mining); absence + grace → gone note; transient errors never false-gone.
  - wake flags: normal → `{triggerTurn:true, deliverAs:"steer"}`; quiet → nextTurn/no-wake; none → no push (pull-only); blocked → always wake; takeover suppresses blocked/mid-conversation pushes; single push per terminal event; re-arm label present.
  - steer watermark: child input matching the watermark ≠ takeover; non-matching input = takeover; spawn's initial prompt ≠ takeover.
  - child-side: takeover marker on input; settle+takenOver → no immediate shutdown, timer fires → `{type:"done",rearm:true}` sidecar + shutdown; keystroke resets; error-grace suppressed under takeover; `parseExitSidecar` rearm typing.
- **NEW** `tests/push-live.mjs` (live, added to `test:live`): real herdr spawn (temp project) → real child completes → `deliverOnce` against real disk + captured sink pushes the **exact** final message (byte-identical to pane-free source); one takeover re-arm round-trip at small N.

## Steps

- [x] 1. `parseExitSidecar` rearm + takeover/steer marker helpers in `sessionfile.ts` (+ tests)
- [x] 2. Child extension: takeover flag/marker, re-arm timer, env stamp, error-grace suppression (+ offline registration tests)
- [x] 3. `src/delivery.ts`: detection routes + push composition + wake flags with injected deps (+ offline red-green)
- [x] 4. Wire-up: spawn stamping + initial-submit watermark, message_agent watermark, `index.ts` registration
- [x] 5. Live round-trip `tests/push-live.mjs`; typecheck; full `npm test`; live suite
- [x] 6. README/CHANGELOG/issue boxes; code review; commit

## Verification

- `npm run typecheck`; `npm test` (offline suite incl. new `tests/delivery.mjs`).
- `npm run test:live` (needs a running `herdr` session): `tests/push-live.mjs` proves one real spawn→push round-trip and the labeled re-arm delivery.
- Manual: spawn an autonomous child, watch the full final message land in the orchestrator with a wake; set `notifications: quiet` → delivery on next natural turn; type into a running child's pane → `user took over` note on next turn, no auto-close, `agent_done` still works; quiet `idle_rearm_minutes` → labeled auto-delivery + pane close + retained session.
