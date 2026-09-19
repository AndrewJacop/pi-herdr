---
label: wayfinder:grilling
status: open
assignee:
blocked-by: []
---

## Question

How does the 43→~7 surface cut ship mechanically? The `surface` key itself is settled in ticket `03` (`.pi/herdr.json` + global, project wins per key, default `"agents"`, read once at init — restart-required, no mid-session setActiveTools swap). Decide here: what exactly hides vs unregisters in `agents` mode, whether the `herdr-qa` sweep prompt (built around 43 tools) runs against both surfaces or gains an agents-mode variant, deprecation story for existing users of the raw tools (CHANGELOG note? escape-hatch doc?), and the README restructure outline (agent-experience first, raw fleet second). QA live tests in `tests/*.mjs` that drive hidden tools must keep a path to run.
