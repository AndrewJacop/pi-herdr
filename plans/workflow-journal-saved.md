# Plan — Issue 13: Workflow resume journal + saved workflows

## Context

`herdr_run_workflow` (issue 12, done) runs sandboxed JS workflows but re-pays every
`agent()` on each run and only accepts inline `script`/`scriptPath`. Issue 13 adds the
replayability half, ported from tintinweb/pi-subagents (clone at `.scratch/pi-subagents/`,
gitignored, MIT):

1. **Resume journal** — every settled `agent()` call appends to
   `<runId>.workflow.jsonl` beside the run's scratch script. `resumeFromRunId` replays
   the **unchanged prefix** (same position + same key + succeeded), so an edited suffix
   pays only the delta. A journaled **failure ends the prefix** (resume-after-failure
   re-runs from the failure). A journal containing any `resumed: true` entry is declined
   whole (a replayed child leaves no conversation to `resume`). Same-session only; the
   determinism jail from issue 12 is what makes prefix replay sound.
2. **Saved workflows** — `name: "<name>"` resolves `<name>.js` through
   `.pi/workflows/` → `.agents/workflows/` → `<agentDir>/workflows/`, **first hit wins**.
   `export const meta = {name, description}` (pure literal) is the marker — a file
   without it is "not a workflow", a validation rule already enforced by issue 12's
   `validateScript`. Also lights up nested `workflow()` (runtime + worker already route
   it; `host.loadWorkflow` is the missing seam).

Upstream reference: `journal.ts`, `saved.ts`, `meta.ts` (already ported), and the journal
hooks inside its `runtime.ts` / `task.ts` / `index.ts`. Decided by
`wayfinder/tickets/08-workflows.md`; no live test required — offline red-green only.

## Approach

Port upstream's `journal.ts` and `saved.ts` near-verbatim (provenance headers, like the
issue-12 ports), port the journal replay branch into our `runtime.ts` with the same
issue-12 trims (no schema, no run-control), and wire the tool/runs layer — ours — to
write the journal beside the scratch script and accept `name` + `resumeFromRunId`.
Inline the three tiny fs helpers upstream imports from `memory.ts`.

## Files to modify

| File | Change |
| --- | --- |
| `src/workflow/journal.ts` | **New (ported).** `WorkflowJournalEntry`, `JournalKeyInput` (no `schema` — issue-14 stretch), `journalKey`, `readJournal` (never throws, skips bad lines), `appendJournal` (write failure is not run failure) |
| `src/workflow/saved.ts` | **New (ported).** `savedWorkflowRoots`, `readSavedWorkflow` (name whitelist, symlink-root rejection, `hasMetaDeclaration` marker, "Available: …" in errors), `resolveWorkflowSource` (name/scriptPath), `resolveWorkflowScript` (scriptPath > script > name), `listSavedWorkflows` (meta-marked `.js` only). Local ~15-line `isUnsafeName`/`isSymlink`/`safeReadFile` (upstream pulls them from `memory.ts`) |
| `src/workflow/runtime.ts` | Port journal branch: `options.journal {entries, append}`, `replayedCount` on result, `cached?: boolean` on agent entries, `replayAt` prefix walker, replay-before-semaphore (cached answers don't hold a slot), re-record replays, journal every settle (success + failure), replay-aware fatal message for `resume:` of a replayed label |
| `src/workflow/runs.ts` | `<runId>.workflow.jsonl` beside the script; wire `journal.append`/`entries`; `resolveResumeTarget` (ported from upstream `task.ts`, against our `runs` map); `resumeFrom` option on `startWorkflowRun`; `, N replayed from <id>` in the completion push; delete `readScriptFile` (superseded) |
| `src/workflow/host.ts` | Implement `loadWorkflow` via `resolveWorkflowSource` (nested `workflow()` goes live); drop the "arrives with issue 13" comment |
| `src/tools/workflow.ts` | Params `name` + `resumeFromRunId` (pattern `^wf_[a-z0-9-]{6,}$`); source resolution via `resolveWorkflowScript`; resume with no source re-runs the prior run's scriptPath; start message reports replay availability; refresh stale header comments |
| `tests/workflow-journal-saved.mjs` | **New.** Offline red-green (below), chained into `package.json` `"test"` after `workflow.mjs` |
| `README.md` | One-line acknowledgement extension: journal + saved-workflow discovery also ported (the existing paragraph already names the port set generically — extend the file list) |

## Reuse

- `src/workflow/meta.ts` — `extractMeta`/`hasMetaDeclaration` already ported (issue 12); saved.ts consumes `hasMetaDeclaration`, validation stays in `validateScript`.
- `src/workflow/runtime.ts` — `handleLoadWorkflow` + worker `workflow()` global already routed; only the host seam is missing.
- `src/workflow/runs.ts` — scratch dir + `<runId>.workflow.js` naming; journal file follows the same id.
- `src/agentdefs.ts` pattern: `getAgentDir()` import from `@earendil-works/pi-coding-agent` for the global workflows root.
- Test harness in `tests/workflow.mjs` — jiti imports, `stubHost()`, mock-`pi` tool capture; copy the patterns.

## Steps

1. Port `src/workflow/journal.ts` (drop the `schema` key-slot; note why in the header).
2. Port `src/workflow/saved.ts` with local fs helpers; global root `join(getAgentDir(), "workflows")`.
3. Runtime: journal option, replay state machine, `cached`/`replayedCount`, replay-aware resume-label error.
4. `runs.ts`: journal path + append + `resolveResumeTarget` + `resumeFrom` option + completion-push replay count.
5. `host.ts`: `loadWorkflow`.
6. `tools/workflow.ts`: `name` + `resumeFromRunId` params, `resolveWorkflowScript` precedence, resume fallback to prior scriptPath.
7. Tests `tests/workflow-journal-saved.mjs` (step 8's cases), add to `package.json` test chain.
8. README acknowledgement + file-header provenance pass.

## Verification

`npx tsc --noEmit`, then `node tests/workflow-journal-saved.mjs`, then full `npm test`.
Offline red-green cases:

- **Journal write/replay** — stub-host run journals settled calls to a tmp `.jsonl`; a second `runWorkflow` with those entries + same script spawns nothing for the prefix (`replayedCount` = prefix length), and a changed prompt at position k runs k.. live.
- **Prefix boundary on failure** — a journaled `ok:false` entry (and a hand-mangled/truncated file) ends replay at that position; resume re-runs the failed agent live.
- **Resume decline** — journal whose entries carry `resumed: true` replays nothing; `resume:` of a replayed label gets the fatal replay-aware error.
- **Discovery order** — same name in `.pi/` > `.agents/` > global: first hit wins; non-workflow `.js` at a winning path → "not a workflow script" refusal; unknown name lists available workflows; unsafe name refused; `resolveWorkflowScript` precedence scriptPath > script > name.
- **Meta pre-parse** — saved file's `meta` parsed before the run starts (run record/tool details carry name+description); non-literal `meta` is a validation error (already enforced; assert through the saved path).
- **Tool surface** — `resumeFromRunId` of a running run refused; unknown id refused with known-run list; resume with no source re-runs prior scriptPath; start message reports `N recorded call(s) available`.
