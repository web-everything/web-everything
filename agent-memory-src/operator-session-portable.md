---
name: operator-session-portable
description: Orchestrator behaviour (sweeps, needs-you watch, quiet rules) must survive a session or account switch; it lives in product files, not session state
metadata:
  type: project
---

The operator orchestrates web-everything from a Claude session, and the session can change: a new session, or a second Claude account. Standing behaviour must carry over without the operator re-explaining it: the 30-min PR movement sweep, the needs-you feed watch, the quiet hours (22:00–07:00 ET), and presenting decisions one at a time with a pick.

**Why:** 2026-10-15, the operator: "we need to take into account that the orchestrating session may change … we have to carry the same behaviour through. eventually the assistant may become a product feature". Session crons and in-chat memory die with the session.

**How to apply:** on a fresh orchestrator session, run the operator-session bootstrap (card 359; feed `needs-you-events.jsonl` in the operations handoff folder) to re-create the sweep cron and the needs-you Monitor, and replay missed items. Run operator-queue from a fresh lane, never from the primary checkout. Keep the canonical prompts in repo or handoff files, never only in session memory. Long term, the orchestrator becomes a daemon-run product feature.
