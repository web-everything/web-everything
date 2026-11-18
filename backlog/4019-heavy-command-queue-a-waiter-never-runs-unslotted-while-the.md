---
bornAs: xhlriy2
kind: story
size: 2
parent: "3383"
status: resolved
scope: ["we:scripts/readiness/heavy-admission.mjs", "we:scripts/readiness/__tests__/heavy-admission.test.mjs"]
dateOpened: "2026-09-23"
dateStarted: "2026-09-23"
dateResolved: "2026-09-23"
graduatedTo: one-off
tags: []
---

# Heavy-command queue: a waiter never runs unslotted while the slot holder is alive

A waiter in we:scripts/readiness/heavy-admission.mjs gives up after DEFAULT_TIMEOUT_MS (20 minutes) and proceeds UNSLOTTED ("fail open"). With test runs taking 25-40 minutes under load and 4-6 lanes waiting, waiters time out and run together, so the cap of 2 stops holding. Change the rule: a waiter proceeds unslotted only when every slot holder is provably dead (reuse the existing pid-liveness probe) or its lease expired; while a holder is alive it keeps waiting, logging a periodic "still waiting" line. Keep an explicit escape (WE_HEAVY_ADMISSION=off) and a hard ceiling far above a normal run (setting, default 120 minutes) so a wedged holder cannot strand a lane forever. Prototype work under #3383: build on lane/mechanical-dispatcher and commit there (no PR, one tracker note per push); the card lives on main; it reaches main through graduation slice #3916 (heavy-admission) or #3917 (dispatch-plan), whose merge notes must union it. Operator ask 2026-09-23: queue many stories and let the AI progress, but limit how many heavy commands run at once. Observed 2026-09-23 on the laptop: load average about 60 against the host core count with the admission cap at 2.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.
