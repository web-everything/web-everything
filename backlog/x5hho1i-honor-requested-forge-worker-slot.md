---
kind: story
status: open
size: 2
dateOpened: '2026-10-31'
scope: ['we:scripts/readiness/forge-exec-run.mjs', 'we:scripts/readiness/__tests__/forge-exec-run.test.mjs', 'we:scripts/readiness/__tests__/forge-worker-pool.test.mjs']
tags: [forge, correctness]
---

# Honor an explicitly requested Forge worker slot

The advisory codex-correctness finding in PR #6059 (2026-10-31) is visible in
`we:scripts/readiness/forge-exec-run.mjs:516`: `reserveWorker` validates a requested
slot against the pool, then iterates the whole pool and reserves the first free
worker. A valid requested slot can therefore differ from the allocated one.
The review directs this behavior change into a separate card.

## Acceptance

- An explicit valid slot reserves that slot only; if occupied, report busy rather
  than allocating another worker.
- With no slot requested, retain first-available allocation. Invalid names remain refused.
- Reservation receipts and cleanup refer to the actual requested worker.

## Test plan

Extend `we:scripts/readiness/__tests__/forge-worker-pool.test.mjs`: request a later
slot while an earlier one is free; request an occupied slot while another is free;
exercise absent and invalid slots and concurrent reservations.

## Non-goals

No pool-size, installer identity or privileged copy changes.
