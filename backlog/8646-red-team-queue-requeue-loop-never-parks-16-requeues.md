---
bornAs: x37fc7m
kind: task
status: open
scope: ["we:scripts/conveyor/red-team-queue.mjs", "we:scripts/conveyor/__tests__/red-team-queue-requeue.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Red-team queue requeue loop never parks (16 requeues)

The red-team queue requeued one PR 16 times. Park it once after N cycles with the same head and reason. Source: build-queue 22:45 ET 2026-11-20.

## Acceptance

- [A1] **Executable** — Planned `parks repeated same-head requeues once at the cycle bound` in `we:scripts/conveyor/__tests__/red-team-queue-requeue.test.mjs`: Replay 16 requeues for the same PR head and reason; assert exactly one park at the configured bound and no further redispatch after parking.

Run `npm run test:unit -- <test-files>` through the host heavy-run queue using the repository-relative paths after the `we:` prefixes above. These cases are planned; this card does not claim they already pass.

## Non-goals

- [N1] No change to review verdict policy.

## Edge cases this change must handle

1. **Untrusted text** — Reasons remain data, never commands.
2. **Truncated reads** — Incomplete queue history cannot prove a fresh cycle.
3. **Shared state files** — Persist the cycle count without duplicate parking.
4. **Fail closed** — Unreadable cycle evidence holds dispatch with a visible reason.
5. **Identity scoping** — Count by PR, head and reason.
6. **State over time** — Cover restart and a changed head or reason.
7. **Who wrote it** — Only queue-owned history counts toward retries.

## Duplicate admission

new-card-from-build-queue-CARD-line --json
