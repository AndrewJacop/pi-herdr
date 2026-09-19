---
label: wayfinder:grilling
status: closed
assignee: Andrew
blocked-by: [01-substrate, 04-launch-plan-routing]
---

## Question

How a child session begins relative to the parent's conversation: fresh, linked, or a copy. Adopts prior art's three `session-mode`s (research/richardh-prior-art.md §7) on the substrate.

## Resolution

1. **Three modes; `standalone` default.**
   - **standalone** — no lineage, fresh session (the previous default).
   - **lineage-only** — seeded header carries `parentSession` linkage, zero copied turns; pi's session UX shows the relationship, enabling later forking/discovery of the lineage.
   - **fork** — full parent conversation copied into the child's session file, **truncated just before the parent's last user message**, session-entry noise filtered. The child boots knowing everything discussed and receives its task as the natural next user turn.
2. **Selection: frontmatter `session-mode:` + spawn-level override** (`fork: true` forces it — the composition an `/iterate`-style flow would use).
3. **Seeding mechanics (from prior art's session.ts, adapted):** the parent (an extension in the orchestrator's pi process) reads its own session file, writes the child header (`type: session`, version 3, fresh id, child cwd, `parentSession` link) plus the mode's content lines to the child path in pi's default sessions dir (ticket `01`), then the launch plan boots pi on it.
4. **Honest costs, stated in the spec:** fork is a **context-copy tax** (the child re-processes the whole parent conversation — for "you know what we've discussed, now do X", never a default) and a **snapshot** (freezes at spawn; the parent keeps moving; the pushed result is the only sync-back).
5. **Registry consequence:** the spawn registry records the mode alongside the session path — resume (ticket `06`) replays the file, whatever its lineage.
