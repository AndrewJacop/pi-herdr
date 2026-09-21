# Plan — Issue 08: Launch plan builder + model/thinking routing chain

Implements [.scratch/v0.6/issues/08-launch-plan-routing.md](../.scratch/v0.6/issues/08-launch-plan-routing.md).
Ruling source: [wayfinder/tickets/04-launch-plan-routing.md](../wayfinder/tickets/04-launch-plan-routing.md), prior art [research §5–6](../wayfinder/research/richardh-prior-art.md).

## Context

Blocked-by tickets are all landed: 02 (settings `models.default` / `models.agents.<name>` resolve, deep-merge project-wins), 03 (frontmatter fields incl. `thinking`, `args:`, `session-mode`, stance), 04 (`--session` seeding + `-e child.ts` already composed inline in `startRecordNow`, `launchPlan` on the record).

Today the argv is composed in two places and the routing chain doesn't exist:
- `buildAgentArgs(spec)` (src/spawn.ts) — spec flags per kind, `agent_args` appended last.
- `startRecordNow` (src/spawn.ts) — prepends `--session <seeded>` + `-e <child.ts>` for pi inline.

Issue 08 wants ONE builder producing the full argv for every spawn, a 5-level
`model`/`thinking` routing chain with enforce-or-error validation (exact
authenticated `provider/model-id`, errors name the offending level),
task-as-artifact for long prompts, identity + mode-hint blocks appended to the
system prompt, frontmatter `args:` + spawn-level `agent_args` append/override,
and stance fields riding the plan end to end.

## Findings (code + pi facts the plan relies on)

- pi CLI flags (pi README): `--model <pattern>` (supports `provider/id`), `--thinking off|minimal|low|medium|high|xhigh|max`, `--system-prompt <text>` (replace; context files and skills still appended), `--append-system-prompt <text>`, `--session <path>`.
- pi extension ctx: `ctx.model` (active model, `.provider`/`.id`, may be undefined), `ctx.thinkingLevel`, `ctx.modelRegistry` with `find(provider, modelId)` (exact), `hasConfiguredAuth(model)` — sync reads on an already-loaded registry. Exactly what enforce-or-error needs.
- Tool execute signature is `(toolCallId, params, signal, onUpdate, ctx)` — `ctx` is currently unused in `src/tools/agents.ts`; thread parent model/registry into `spawnAgent` via deps.
- Session JSONL assistant messages carry `provider` + `model` (pi docs/session-format.md) → the live check asserts the child booted on the pinned model by reading the child's first assistant message.
- `mergeSpawnSpec` already merges spawn-level `kind`/`model` over the definition; `thinking` needs the same merge. `AgentDefinition` already carries `thinking` + `agent_args` (frontmatter `args:` parses to it, round-trip tested in 03).
- `SpawnRecord` already has `launchPlan`, `stance`, `isolated`, `sessionPath`, `activityPath`; `session_mode` is not on the record yet.
- Multiline values materialize to temp files (`materializeAgentArgs`, `PROMPT_FILE_FLAGS` = the two system-prompt flags) — reuse for the new multiline carriers.
- Sidecar naming precedent: `<session>.exit`, `<session>.activity.json` → task artifact becomes `<session>.task.md`.
- Tests import src through one jiti instance (split-brain warning in tests/spawn.mjs) — new tests consume `src/launchplan.ts` and spawn re-exports accordingly.

## Decisions (user-confirmed)

1. **Level-5 thinking: omit the flag.** Model at level 5 pins the parent's `provider/id` explicitly; thinking at level 5 emits no `--thinking` — the child uses its own configured default. (Level 5 for model is likewise omitted when the parent has no active model.)
2. **Task artifact lives beside the session file**: `<sessionPath>.task.md` in pi's default sessions dir — parent-owned, never deleted, resolvable when issue 10 resumes the session.
3. **Lean identity + mode-hint blocks** (3–6 lines; exact wording pinned below).

## Routing chain (5 levels; model AND thinking resolve identically)

1. spawn `model`/`thinking` param (one-off, wins)
2. definition frontmatter `model`/`thinking`
3. `models.agents.<name>` (settings; name = definition registry name; inline definitions match by their name)
4. `models.default` (settings; `""` = unset → fall through; `""` entries in `models.agents` equally unset)
5. parent session's model (pinned explicitly) / thinking (omitted — see decision 1)

**Enforce-or-error, no fuzzy resolution:**
- A model value must be exactly `provider/model-id` (split on first `/`; bare ids rejected with an error); `registry.find(provider, id)` must hit; `hasConfiguredAuth(model)` must be true. Every failure names the supplying level: "routing level 1 (spawn param)", "level 2 (frontmatter of 'scout')", "level 3 (models.agents pin for 'scout')", "level 4 (models.default)", "level 5 (parent session)".
- A thinking value must be a valid pi level (`off|minimal|low|medium|high|xhigh|max`); failures name the level the same way.
- Capability honesty: `KindCaps` grows `thinking` (pi only). An explicit (levels 1–4) thinking value on a kind without a thinking flag errors naming the level and the kind; level-5 thinking for such kinds is a no-op (nothing to enforce — mirrors how unset fields behave in `validateKindEnforcement`). Model on kinds without model caps keeps the existing `validateKindEnforcement` error (levels 3/4 merge onto `spec.model` before it runs, so it covers every explicit level; level 5 on a no-model-cap kind is a no-op).
- Settings values are read at spawn time (hot-reload rule); resolved values are stored on the record, so a queued drain composes the identical argv the moment it starts.

## Pinned block wording (lean)

```
You are herdr/<name> (type: <type>), spawned by a pi-herdr orchestrator.
```
- Autonomous stance only, appended: `When your task is complete, write your full final summary as a normal message; settling ends your run (agent_done declares it).`
- `session-mode: lineage-only|fork` only: `Your session was seeded from a parent conversation; treat earlier turns as context, not your own actions.` (standalone emits nothing)
- Neither block = no `--append-system-prompt` for blocks alone (argv stays minimal).

## Task-as-artifact

- Threshold: `TASK_ARTIFACT_THRESHOLD = 2000` chars (`prompt.length >` threshold → artifact). Named constant; not a setting (YAGNI).
- Written at start time (after seeding, when `sessionPath` exists) as `<sessionPath>.task.md`; queued records write at drain time like they seed then.
- Prompt submitted becomes exactly one line: `Read your task from <path> and execute it; the file is the complete task.` (single-line-safe; the steer watermark stamps this one-liner, which is what the child actually receives).
- Short prompts flow through unchanged.

## Approach

New module **`src/launchplan.ts`** — pure, offline-testable:

- `RoutingLevel` = `"spawn" | "frontmatter" | "agents-pin" | "models-default" | "parent"` (+ `"unset"`).
- `resolveRouting({ spawn, definition, settings, parent })` → `{ model?, thinking?, modelSource, thinkingSource }` — pure precedence; level-5 model adopts `parent.model` (undefined → unset), level-5 thinking always unsets.
- `validateRouting(resolved, caps, registry)` → `Err | null` — registry interface `{ find(provider, id), hasConfiguredAuth(model) }` injected (fakes in tests); checks format/existence/auth for model, enum for thinking, thinking-capability gate with level names in every message.
- `buildIdentityBlock({name, type})`, `buildModeHintBlock({stance, sessionMode})` → strings (wording above).
- `buildTaskPrompt(prompt, sessionPath, deps)` → `{ prompt, artifactPath? }` (deps-injected `writeFile`).
- `buildLaunchPlan({ kind, sessionPath?, childExtension, specFlags, defAgentArgs, spawnAgentArgs, identity, modeHint, ... })` → full argv. pi branch: `["--session", path, "-e", ext, ...specFlags, ...defAgentArgs, ...spawnAgentArgs]`; non-pi branch: `[...specFlags, ...defAgentArgs, ...spawnAgentArgs]` (honest one-liner passthrough unchanged).

`src/spawn.ts` integration:
- `buildAgentArgs` gains the pi `--thinking` flag (from merged spec) — it stays the per-kind flag composer the builder calls.
- `mergeSpawnSpec` gains `thinking` (spawn param > definition).
- `spawnAgent`: after merge, resolve + validate routing BEFORE gates/side effects (refusals never precede validation); store `record.routing` + `record.session_mode`; pass spawn-level `agent_args` through materialization.
- `startRecordNow`: delegates to `buildLaunchPlan` + `buildTaskPrompt` instead of composing inline; `record.launchPlan` records the exact argv (unchanged contract).
- `SpawnParams`/tool schema grow `thinking`, `agent_args`; `SpawnRecord`/`SpawnResultData` grow `session_mode` + resolved `model`/`thinking` (result surfaces what the child actually runs on).
- Spawn-level `agent_args` merge rule: appended LAST (`[...computed, ...def.agent_args, ...spawn.agent_args]`) — last-wins argv semantics give the documented append/override behavior against frontmatter `args:` and computed flags alike. Raw flags bypass routing validation by design (documented escape hatch).

`src/tools/agents.ts`:
- `execute` gains the `ctx` param; threads `deps.parent = ctx.model ? {provider, id} : undefined` and `deps.registry = ctx.modelRegistry` into `spawnAgent`.
- Schema + description: `thinking`, `agent_args` params; routing-chain and `args:`/`agent_args` docs in the description.

## Files to modify

- `src/launchplan.ts` (new) — routing, blocks, task artifact, argv builder
- `src/spawn.ts` — builder delegation, routing resolve/validate, `thinking` merge, record/result fields
- `src/tools/agents.ts` — schema (`thinking`, `agent_args`), ctx threading, description
- `tests/launchplan.mjs` (new) — goldens + routing chain
- `tests/spawn.mjs` — assertions touching old argv composition; spawn-level `agent_args`/`thinking` wiring
- `package.json` — add `tests/launchplan.mjs` to `test`
- `docs/concepts.md` — routing-chain section; `README.md` — routing + `agent_args` notes
- `CHANGELOG.md` — entry

## Reuse

- `materializeAgentArgs` + `PROMPT_FILE_FLAGS` (src/spawn.ts) — multiline carriers incl. the new combined append value
- `seedSessionFile` / `sessionsDirFor` (src/sessionfile.ts) — artifact home `<session>.task.md`
- `loadSettings`/`getSettingsPaths` (src/settings.ts) — `models.*`
- `childExtensionPath()` (src/spawn.ts) — `-e` value
- `KIND_CAPABILITIES`/`validateKindEnforcement` (src/spawn.ts) — capability honesty pattern
- jiti single-instance test pattern (tests/spawn.mjs)

## Steps (TDD, red→green per slice)

- [x] 1. `resolveRouting`: each level wins in isolation; `""`/absent fall-through; thinking resolves independently of model; level-5 model adopts parent, level-5 thinking unsets
- [x] 2. `validateRouting`: bare id, unknown model, unauthenticated provider, bad thinking enum, thinking-on-thinking-incapable kind — each error names its level; registry faked
- [x] 3. Task artifact: short inline; long → `<session>.task.md` + one-line reference; deps-injected writeFile
- [x] 4. Blocks: golden strings per stance/session-mode; replace vs append flag composition; multiline → temp-file paths via `materializeAgentArgs`
- [x] 5. `buildLaunchPlan` goldens: default pi argv order (`--session` → `-e` → spec flags → def args → spawn args), non-pi passthrough unchanged, frontmatter `args: ["--plan"]` + spawn `agent_args` append/override (last-wins), thinking flag pi-only
- [x] 6. Wire into `spawnAgent`/`startRecordNow`: validation before side effects; record carries `routing` + `session_mode`; queued drains compose identical argv; ctx threading in the tool; update touched spawn.mjs tests; full offline suite green
- [x] 7. Live check (tests/spawn-live.mjs): settings-pinned `models.agents.<name>` spawn → child's first JSONL assistant message carries the pinned `provider`/`model`
- [x] 8. Docs (concepts + README) + CHANGELOG; `/code-review`; commit to current branch

## Verification

- `npm run typecheck`; `node tests/launchplan.mjs`; full offline `npm test`
- Live: `npm run test:live` (spawn-live addition asserting the pinned model from the child's JSONL)
- Manual: pin `models.agents.Explore` in `.pi/herdr.json`, spawn Explore → footer/model of the child matches; spawn with spawn-level `model` override → override wins; frontmatter `args: ["--plan"]` definition shows `--plan` in the child argv

## Out of scope

- Session-mode seeding mechanics (issue 09 consumes `session_mode`; only the field riding the plan + the mode-hint block live here)
- Resume re-deriving the plan (issue 10 calls the same builder — noted, not built)
- Workflow `agent()` host seam (issue 12)
- Any multi-harness driver layer (killed by the ruling)
- Making the task-artifact threshold configurable
