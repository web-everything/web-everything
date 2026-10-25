---
bornAs: xnfww33
kind: story
size: 2
status: open
scope: ["we:scripts/lib/enqueue-on-event.mjs"]
dateOpened: "2026-10-14"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5277 (head 6bc79e895)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5277 (reviewed head `6bc79e895a775220b0eb2eaa61cef883b8e7e1eb`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/enqueue-on-event.mjs:681` — (edge-case, degraded) Stale queue membership suppresses the busy retry after a PR leaves the queue.
   - Scenario: With capacity 3, initially list PR 1 as queued and PR 2 as unqueued. While PR 2 drains, remove PR 1 from the queue while leaving it open and ready, then enqueue PR 2. The final live snapshot correctly reports queuedNums:[2], but p.inQueue from the initial listing unconditionally excludes PR 1. An injected-I/O probe logged 'next round in 600s (nothing runnable)' and performed no listing after 60 seconds. It should recognize PR 1 as unqueued runnable work and schedule the configured 60-second retry. Removing the stale membership check in memory made that same probe schedule 60 seconds.
   - Claude's re-check: The busy check skips any PR with 'p.inQueue' from the round's initial listing, even when the live 'queuedNums' shows it has since left the queue. A PR that was queued at listing time and later dropped out, while still open and ready, is never counted as runnable. 'busy' stays false and the 600s interval is used instead of the 60s busy retry.
2. `we:scripts/lib/enqueue-on-event.mjs:476` — (edge-case, degraded) Changing intervalMinutes leaves the previous catch-up deadline in force.
   - Scenario: Complete an idle round with intervalMinutes:10, then change the setting to intervalMinutes:1. After one minute, tick() reads and exposes the new interval but performs no catch-up listing because nextCatchUpAt still holds the old ten-minute deadline. An injected-I/O probe observed one listing after one minute and a second only after ten minutes. The previous implementation evaluated elapsed time against the current setting. Subsequent ticks should honor the changed interval; with an initial interval of 240, this regression can delay the requested cadence for four hours.
   - Claude's re-check: 'catchUpDue' now compares only against 'nextCatchUpAt', which is fixed at round end from the interval in force then. The old code compared elapsed time with the current 'intervalMinutes'. If the setting drops from 10 to 1 minute, the old deadline still applies, so the new cadence is ignored until it expires.

## Acceptance

- [A1] **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] TODO: what this item deliberately does not do — or `n/a: <why>` when nothing is excluded.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
