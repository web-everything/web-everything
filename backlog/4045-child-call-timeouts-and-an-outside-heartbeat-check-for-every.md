---
bornAs: xi58xoz
kind: story
size: 3
parent: "3383"
status: open
scope: ["we:skills-src/conveyor/", "we:scripts/lib/daemon-self-sync.mjs"]
dateOpened: "2026-09-23"
tags: []
---

# Child-call timeouts and an outside heartbeat check for every resident daemon

Ruling #3681, we:docs/agent/platform-decisions.md#resident-daemon-reload-lifecycle clause 6. A per-tick budget cannot fire inside a synchronous execFileSync, so on 2026-09-23 an unreviewed we:scripts/lane-pool.mjs change hung the fix daemon's tick for more than 5 minutes and nothing noticed. Put a timeout on every child call a daemon tick makes, and add a check outside the daemon that its heartbeat keeps moving and alerts when it stalls. The overlay rollback builds on this check.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

## Additions from 2026-09-24 incident review

Operator proposal 3 ("daemon-level stall alerts: owed work exists but nothing dispatched for N ticks") lands here, because this card already owns "a check outside the daemon that alerts when it stalls". A moving heartbeat alone missed every stall seen on 2026-09-24: in each case the daemon was alive and ticking. The outside check should read four signals, not one:

1. **Heartbeat stale** (as filed).
2. **Behind main.** The daemon's running revision (from #4051) is more than K commits or T minutes behind origin/main. Live case: a daemon ran 9 commits behind main because the #4038 smoke gate rejected an update and, by design, "stays on old code" with only a log line. That is the right safety call, but a rejection must become an alert, or the fleet silently freezes on old code.
3. **Owed but not dispatched.** The daemon's own tick log reports owed work and zero dispatches for N consecutive ticks (review and fix daemons), or the queue is non-empty and the dispatcher admits nothing (the dispatch-eligibility operation names the hold). Live case #3951: two PRs were dropped from the owed count for hours behind a stuck bound session while the log read "3 owed, dispatched 3".
4. **Auth failure rate.** More than M sessions dispatched by one daemon fail on an HTTP 401 inside a window. Live case: one rejected App token failed every review session until #4039 added a retry.

One alert path for all daemons: a line in /wip Needs you (the Fleet panel card, 4057) plus a desktop notification, the way #2493 did it for the drain. #3756 (runner-down alert) and #3398 (supervisor idle-with-queue) should emit through the same path, not a third one. If this grows past size 3, split signals 2–4 into their own card and keep timeouts plus heartbeat here.
