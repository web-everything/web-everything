---
bornAs: xegykal
kind: story
size: 5
parent: "3383"
status: resolved
scaffoldedBy: "session-watchdog-lane-7"
dateScaffolded: "2026-10-04"
dateOpened: "2026-10-04"
dateResolved: "2026-10-04"
tags: []
---

# Session watchdog: read each conveyor session's transcript once it passes its standard duration

Operator 2026-10-04 ~09:30 ET: 'we need a system that actually checks the transcript at regular intervals after standard duration'. fix-3771 held its fix claim 1h27 looping on 11 verify-lane 9-minute waits; hung-session (30-min idle) could not see it, no smell measured fix-claim age, and four September sessions still read state:working. Build a health-watch watchdog that classifies every live conveyor session past its kind's standard duration (active-progress / waiting-loop / stalled / finished-but-listed / ghost) from a bounded transcript tail, raises smells for stuck fixers and claims held with no progress, hands stuck fixers to the escalation ladder via a typed event, and clears ghosts through claude rm.

## Done when

1. **Executable** — `node we:scripts/conveyor/soak/red-green.mjs --break=fixer-wait-loop-undetected` proves RED on the
   tree before the watchdog (fix-3771's recorded 11-wait loop is undetected: hung-session reads it `fresh`, no
   episode names PR #3771) and GREEN with it (`fixer-stuck` and `fix-claim-held-no-progress` open on PR #3771).
2. `npx vitest run we:scripts/conveyor/__tests__/session-watchdog.test.mjs` covers every classification and action.
3. The health watch's first live pass lists every current conveyor session with its classification, including the
   September ghosts, and clears each ghost through `claude rm` (or records that `claude rm` cannot).

Design and the escalation event contract: `we:docs/agent/dispatcher-runbook.md` → "The session watchdog".
