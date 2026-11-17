---
kind: task
workItem: task
status: open
dateOpened: "2026-11-16"
tags: []
related: ["8409"]
---

# S2b: adoption-scoped outcome checks

Follow-up to PR #6882, ruling R952/R955. S2a deliberately removes unused outcome-check registration and asynchronous probes. A future outcome checker must retain the adoptionId across awaits and re-read under withProbationLock before mutating probation, marker or provenGood.

## Acceptance

- Register a real production outcome consumer before introducing the API.
- Bound each asynchronous check and refuse incomplete evidence.
- Test replacement adoption during a suspended probe; stale results must change no file.
- Preserve caller-owned restart and boot-time deadlines. Outcome checks must not introduce a timer that exits the daemon.

## Interim

S2a proves liveness from completed ticks only. It does not claim semantic outcome health.
