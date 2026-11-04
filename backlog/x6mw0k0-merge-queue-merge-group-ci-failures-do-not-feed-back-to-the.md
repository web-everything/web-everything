---
kind: story
size: 3
status: open
scope: ["we:scripts/lib/pr-facts.mjs"]
dateOpened: "2026-11-03"
tags: []
---

# Merge-queue (merge_group) CI failures do not feed back to the fixer; the drain retried the same red PR 3 times

When a PR fails its merge_group CI run, nothing sends that failure back to the fixer. PR #6287 (accepted, ready-to-merge) failed test-shard (4) in the merge queue on 2026-11-03 because the merged result with main carried 85 malformed backlog scope entries (a real-backlog guard, expected 104 to be less than 30). The branch-level CI was green, so no daemon saw a red signal, and the drain retried the same PR 3 times. Feed merge_group failures back as a `changes` send-back with the failing check and message, and stop the drain re-queueing a head whose last merge_group run failed.

## Acceptance

- [A1] **Executable** — a unit test over the drain/fix-dispatch path: a head whose latest merge_group run concluded failure is not re-queued and produces a fix dispatch carrying the failing check name and first assertion line; it fails before this lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] Does not change branch-level CI or the merge queue itself; no auto-retry of flaky merge_group runs.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: reads a CI conclusion and check name only; a missing or unreadable run fails closed to the existing behaviour (no re-queue).
2. **Truncated reads** — n/a: reads a CI conclusion and check name only; a missing or unreadable run fails closed to the existing behaviour (no re-queue).
3. **Shared state files** — n/a: reads a CI conclusion and check name only; a missing or unreadable run fails closed to the existing behaviour (no re-queue).
4. **Fail closed** — n/a: reads a CI conclusion and check name only; a missing or unreadable run fails closed to the existing behaviour (no re-queue).
5. **Identity scoping** — n/a: reads a CI conclusion and check name only; a missing or unreadable run fails closed to the existing behaviour (no re-queue).
6. **State over time** — n/a: reads a CI conclusion and check name only; a missing or unreadable run fails closed to the existing behaviour (no re-queue).
7. **Who wrote it** — n/a: reads a CI conclusion and check name only; a missing or unreadable run fails closed to the existing behaviour (no re-queue).
