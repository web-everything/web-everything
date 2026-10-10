---
bornAs: xuqk1vp
kind: story
size: 3
parent: "4075"
status: resolved
dateOpened: "2026-09-24"
dateStarted: "2026-09-25"
dateResolved: "2026-10-09"
graduatedTo: 5bfe2180c
tags: []
scope: ["we:scripts/lane-drain.mjs", "we:scripts/readiness/drain-lock.mjs", "we:scripts/backlog/id.mjs"]
---

# Numbering lock: reclaim only a dead holder and never run a write-to-main section unlocked

Audit: we:reports/2026-09-24-daemon-blocking-antipatterns.md (adversarial round). Finding A3 (speed and safety). withNumberingLock defaults to runUnlockedOnContention: true (we:scripts/readiness/drain-lock.mjs 162, 172-175), and a holder is reclaimed on its 5-minute TTL alone because the pid check is not used. While the drain's numbering section runs about 7 min (finding D1), any second lander (a fast-drain merge through withLandWriteLock, we:scripts/pr-land.mjs, or the pre-push numbering in we:scripts/lib/number-pending-hashes-before-push.mjs) waits 5 min and then writes to main with no lock: the duplicate-number race the lock exists to stop. Fix shape: heartbeat the lock while the section runs; reclaim only when the holder pid is gone or the heartbeat is stale; writers to main get ran:false on contention (the #3637 POC-land contract) instead of running unlocked. Land after 4127 so the section is seconds long. Done when: tests for a live slow holder (no reclaim, no unlocked run) and a dead holder (reclaimed); LIVE proof: two concurrent numbering calls in a scratch clone serialize, lock timeline in the PR.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.
