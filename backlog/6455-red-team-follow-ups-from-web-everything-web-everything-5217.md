---
bornAs: x8zt8kq
kind: story
size: 2
status: open
scope: ["we:scripts/lib/merge-queue-adaptive-batching.mjs"]
dateOpened: "2026-10-14"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5217 (head cd633d5b9)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5217 (reviewed head `cd633d5b9654ac5dec0b0efd6822c1659a4d2a29`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/merge-queue-adaptive-batching.mjs:235` — (edge-case, degraded) Enqueue confirmation counts expired failures when entering strict mode.
   - Scenario: Persist two failures at minute 0 and minute 1 plus an active, seen singleton. Resume at minute 1440 with the default failureThreshold=3 and failureWindowMinutes=120. If that singleton exits between gate and enqueue, confirm(...,{already:false}) calls recordQueueExit without pruning old failures. The new failure raises the retained count to three and sets strictUntilMs to minute 1500. A Node probe reproduced this; the following observe() pruned the two expired failures but retained the strict deadline, and the next gate returned mode=strict with only one recent failure. Failure-window pruning s
   - Claude's re-check: confirm() calls recordQueueExit, which tests 'state.failures.length &gt;= failureThreshold' without pruning by failureWindowMinutes. Pruning only happens in observeQueue, and the drain's enqueue/confirm step runs before observe in a pass. Stale failures can therefore trigger strict mode, and a later observe doesn't clear the deadline.

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
