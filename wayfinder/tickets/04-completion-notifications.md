---
label: wayfinder:grilling
status: open
assignee:
blocked-by: []
---

## Question

How do background agent completions become notifications? Design the watcher (poll herdr agent status — existing footer logic is the seed; what interval, what dedup), the completion-event → `pi.sendMessage` nextTurn delivery, and the notification content/format (themed box, result preview via `agent read`, duration, status — blocked/failed states made loud; no token/cost claims). Include: behavior when the orchestrator session is mid-turn, notification for *blocked* agents (not just completion), and how the model consumes a result it missed (`get_agent_result` interplay). Zoom tintinweb's `index.ts` notification path and ticket `09`'s findings when ready.
