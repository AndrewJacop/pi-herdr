# Glossary

Terms as used across pi-herdr docs, the wayfinder map, and tickets. Decisions live in `wayfinder/`, not here.

- **Settings** — user-facing behavior knobs for the extension. Effective settings are the deep merge of the global file and the project file; **project wins per key**. A setting's **source** is whichever file supplied it (project, global, or built-in default).
- **Surface** — which tool set the model sees: `agents` (the v0.5 agent-experience tools) or `full` (the complete fleet tool set). Chosen in settings; fixed for the session.
- **Agent kind** — which CLI runs in an agent pane (pi, claude, codex, …). A definition supplies a default kind; a spawn may override it.
- **Kill-switch** — the settings gate that refuses new agent spawns. It never terminates anything; see *kill all agents*.
- **Kill all agents** — the `/herdr` menu action that terminates every running agent pane, after confirmation.
- **Queued agent** — an accepted spawn that has no pane yet because the fleet is at its concurrency cap; it starts when a slot frees.
- **Spawn depth** — how many spawns deep an agent is from the originating session; the guard against runaway recursive fleets.
