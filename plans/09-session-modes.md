# Plan — v0.6 issue 09: Session modes (standalone / lineage-only / fork)

## Context

Issue [09-session-modes](.scratch/v0.6/issues/09-session-modes.md) (decided by [wayfinder/tickets/05-session-modes.md](wayfinder/tickets/05-session-modes.md), prior art research §7). How a child session begins relative to the parent's conversation:

- **standalone** (default) — fresh, no lineage; today's behavior, unchanged.
- **lineage-only** — the seeded child header carries the `parentSession` link, zero copied turns; pi's `/resume` shows the relationship.
- **fork** — the parent conversation copied into the child's session file, **truncated just before the parent's last user message**, session-entry noise filtered — the child boots knowing everything discussed and receives its task as the natural next user turn.

Selection: frontmatter `session-mode:` (already parsed in v0.6 issue 03 → `AgentDefinition.session_mode`) + spawn-level `fork: true` override (forces fork — the `/iterate`-style composition). Honest costs, stated in docs: fork is a **context-copy tax** and a **snapshot** (freezes at spawn; the pushed result is the only sync-back).

Blocked-by 04 (substrate) and 08 (launch plan) are landed. Registry (`SpawnRecord.session_mode`) already carries the field — this ticket makes it real (seeding + effective value).

## pi session-file facts (verified in `node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js`)

- Header shape (v3): `{"type":"session","version":3,"id":"<uuid>","timestamp":"<ISO>","cwd":"<resolved>","parentSession":"<parent session FILE path>"}`. `parentSession` = path — pi's own fork flow writes `currentSessionFile` there; the `/resume` session selector builds its lineage tree from it.
- `--session <path>` where the file is **empty** → pi writes a fresh header itself (standalone today). **Non-empty** → opened as-is: leaf = last non-header entry, context built by walking `parentId` from the leaf. **Non-empty but invalid** (first line not `{type:"session", id}`) → pi throws. So a pre-seeded file must be exactly right.
- Consequence for fork: copied entries **must be re-chained** (`parentId` relinked linearly, first copied entry = root) — original parentIds point into filtered-out entries and would truncate pi's context walk. Original `id`/`timestamp`/`message` objects stay verbatim.
- The orchestrator's own session path comes from `ctx.sessionManager.getSessionFile()` (`ReadonlySessionManager` pick — already available in the tool's `ctx`).

## What already exists (reuse)

| Piece | Where |
|---|---|
| Tolerant session-JSONL parsing (`parseSessionEntries`) | `src/sessionfile.ts` |
| Seeding into pi's default sessions dir (`seedSessionFile`, `sessionsDirFor`) | `src/sessionfile.ts` |
| Seeding orchestration at start time, post-worktree final cwd (`seedRecordSession` in `startRecordNow`) | `src/spawn.ts` |
| `SessionMode` type + frontmatter `session-mode:` parsing + inline `session_mode` validation | `src/agentdefs.ts` |
| Mode-hint block already words the seeded-lineage note for lineage-only/fork children (`buildModeHintBlock`) | `src/launchplan.ts` — **no change needed** |
| Registry field `session_mode`, result reporting via `routingResultFields` | `src/spawn.ts` |
| Offline test harness (jiti imports, injected deps incl. `seed`), live round-trip pattern | `tests/substrate.mjs`, `tests/spawn-live.mjs` |

## Approach

**1. Pure seeding core — `src/sessionfile.ts`** (new section "session modes"):

- `buildChildHeader({cwd, parentSession?}, {now?, uuid?})` → the v3 header (fresh uuid id, child cwd, `parentSession` link).
- `forkCopyEntries(entries)` → the fork copy: scan backwards for the LAST `type:"message"` entry with `message.role === "user"`; take message entries strictly before it (no user message → take all); keep **only** `type:"message"` entries (noise filter: model/thinking changes, compaction + branch summaries, custom extension entries, labels are session bookkeeping, not conversation); re-chain `parentId` linearly (first = `null`); missing `id` → `herdr-fork-<n>`. Cutting at a user boundary can never split a toolCall/toolResult pair (those live inside a completed assistant turn). Pre-compaction messages copy too — the fork is a snapshot of the conversation, not of the parent's context window (comment says so).
- `buildSessionSeedLines({cwd, parentSession, mode, parentEntries}, deps?)` → `[header, ...forkCopy?]` as JSON strings. Standalone never calls it (file stays empty).

**2. Spawn engine — `src/spawn.ts`**:

- `SpawnParams.fork?: boolean`; after merge: `if (params.fork) merged.session_mode = "fork"` (spawn override > frontmatter > standalone).
- `SpawnDeps.parentSession?: string` (the orchestrator's own session file path) + two test seams: `readParentEntries?` (default: `parseSessionEntries(readFileSync(path))`, null on failure) and `writeSessionSeed?` (default: write joined lines).
- In `seedRecordSession` (runs at start time, final cwd known): mode = `record.session_mode ?? "standalone"`; if non-standalone and parent entries are readable → write the seed lines into the freshly created empty file; else **degrade to standalone** (no parent path — e.g. in-memory orchestrator session — or unreadable file: a fork without a parent conversation *is* standalone) and set `record.session_mode = "standalone"` so the registry/reports show the effective mode.
- All four return paths report `record.session_mode` (not the pre-start merged value) via `routingResultFields`.
- `validateKindEnforcement`: a *meaningful* `session_mode` (`lineage-only`/`fork`) on a kind without a session substrate (non-pi) refuses, naming the field — the module's own enforce-or-error rule; one new `KindCaps.session` flag (pi true, everything else false).

**3. Tool surface — `src/tools/agents.ts`**:

- `herdr_spawn_agent` gains `fork?: boolean` param; threads `fork: p.fork` and `parentSession: ctx?.sessionManager?.getSessionFile()`.
- DESCRIPTION: the three modes + honest costs (context-copy tax, snapshot; "never a default").

**4. Tests — `tests/modes.mjs`** (offline, added to `npm test`), red-green at the pre-agreed seams:

- Header shape: `type/version/id/timestamp/cwd/parentSession` exactly.
- Truncation boundary: cuts before the last user message (later assistant replies to it dropped; no user message → all copied).
- Noise filter: only message entries copy; re-chain verified (first parentId null, linear, original ids/messages verbatim).
- `buildSessionSeedLines`: lineage-only = header only; fork = header + copy.
- Selection: `fork: true` forces fork over frontmatter; frontmatter `session_mode` alone works; default standalone.
- Seeding e2e through `spawnAgent` with injected deps: lineage-only file on disk = one header line with the link; fork file = header + copied lines; standalone file stays **empty**; registry records the **effective** mode alongside sessionPath; degrade (no `parentSession`) → standalone recorded, file empty.
- Non-pi refusal: `fork: true` with `kind: "claude"` → VALIDATION_ERROR naming the field.

**5. Live check — `tests/modes-live.mjs`** (added to `test:live`; the ticket's acceptance item): fabricate a parent session JSONL containing a distinctive fact, spawn with `fork: true` asking for that fact only → the child answers it **without being told** (proves the copy rides the session, not the prompt); lineage-only spawn → child file's second line is its own prompt (zero copied turns) and the header carries `parentSession`.

**6. Docs**: README (spawn entry point + registry section: the "session-mode ticket lands the seeding next" note becomes the real behavior; `fork` param), CHANGELOG (Unreleased → Added).

## Files to modify

- `src/sessionfile.ts` — pure seeding core (header, fork copy, seed lines)
- `src/spawn.ts` — `fork` param, mode application + seeding, degrade, effective-mode reporting, kind enforcement
- `src/tools/agents.ts` — `fork` param, `parentSession` threading, description
- `tests/modes.mjs` — new offline suite (+ `package.json` test script)
- `tests/modes-live.mjs` — new live suite (+ `package.json` test:live script)
- `README.md`, `CHANGELOG.md` — docs

## Steps

- [x] 1. Red: write `tests/modes.mjs` sections 1–3 (header shape, truncation boundary, noise filter + re-chain) against the not-yet-existing pure fns
- [x] 2. Green: implement `buildChildHeader`, `forkCopyEntries`, `buildSessionSeedLines` in `src/sessionfile.ts`
- [x] 3. Red→green: selection/override/degrade/seeding e2e tests; implement `fork` param + seeding in `src/spawn.ts` (+ non-pi refusal)
- [x] 4. Thread through the tool surface (`src/tools/agents.ts`), schema + description
- [x] 5. `node tests/modes.mjs` green; `npm run typecheck` clean; full `npm test`
- [x] 6. Live suite `tests/modes-live.mjs` + run against a live herdr session (fork child answers the parent-conversation question unprompted)
- [x] 7. README + CHANGELOG
- [x] 8. `/code-review` the work; fix findings
- [x] 9. Commit to the current branch (feat: session modes — standalone / lineage-only / fork, v0.6 issue 09)

## Verification

1. `npm run typecheck`
2. `node tests/modes.mjs` (new offline suite) + full `npm test`
3. `node tests/modes-live.mjs` with a running herdr session — fork child recites the fabricated parent-conversation fact with no hint in its prompt; lineage-only child file = header link + own turns only
4. `/resume` in a pi session on the child cwd shows the lineage link (header `parentSession`)

## Decisions taken in this plan (deny-with-feedback if you disagree)

- **Degrade, don't refuse**, when the parent session path is missing/unreadable: fork/lineage-only without a parent conversation *is* standalone; the registry records the effective mode so nothing lies.
- **Fork copies message entries only** (all roles) — compaction/branch/model/custom entries are dropped; pre-compaction messages DO copy (snapshot semantics, not context-window semantics).
- **`fork: true` / frontmatter `session-mode` on a non-pi kind refuses** (enforce-or-error, naming the field) — consistent with the surface's honesty rule.

## Amendment during execution

The first decision above was **revised while implementing**: `session_mode` keeps
reporting the **selected** mode (what the launch plan rode) even on degrade —
overwrite-on-degrade broke the issue-08 contract pinned by `tests/launchplan.mjs`
(the field surfaces the selection) and made the spawn result depend on seed-time
file I/O. On degrade the FILE stays empty (standalone on disk); the mode field
answers "what was selected". README/CHANGELOG document this; the degrade tests
in `tests/modes.mjs` pin it (empty file + `session_mode: "fork"` reported).
