---
kind: story
size: 5
status: open
scope: ["we:scripts/lib/merge-queue-enqueue.mjs", "we:scripts/lib/review-escalation.mjs", "we:scripts/lib/drain-queue-safety.mjs", "we:scripts/lib/drain-merge-strategy.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# sendBackReason omits review:held-mechanical while the merge predicate counts it as a hold

Flow-sim gap D-C5, class K9 (divergent predicates for one state). Failing input: labels [ready-to-merge, review:accepted, review:held-mechanical] on the live read at enqueue (a concurrent drain parked the PR for test-gaming and its ready-to-merge strip failed best-effort, MAP:6027-6032 catch swallowed; or a person added the label)' 'label added after the pass-start classification, or while already queued Cited: we:scripts/lib/merge-queue-enqueue.mjs:292, we:scripts/lib/review-escalation.mjs:2528, we:scripts/lib/drain-queue-safety.mjs:452-455, we:scripts/lib/drain-merge-strategy.mjs:390, we:scripts/lib/drain-merge-strategy.mjs:532. Soak-break sketch: none

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
