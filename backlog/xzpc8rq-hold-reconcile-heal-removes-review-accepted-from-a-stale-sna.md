---
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor/review-hold-reconcile.mjs", "we:scripts/review-set-label.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# Hold-reconcile heal removes review:accepted from a stale snapshot after a concurrent clear-human

Flow-sim gap A-C7, class K6 (check-then-act race with no pin). Failing input: labels: [review:accepted, review:human] files: 'PR thread has no clear-human record for the live head (parseLatestHumanClearedSha != head), so heal.heal is true' operator runs review-set-label --to=clear-human between the sweep's live read and its label write Cited: we:scripts/conveyor/review-hold-reconcile.mjs:314-322, we:scripts/conveyor/review-hold-reconcile.mjs:327, we:scripts/conveyor/review-hold-reconcile.mjs:340-348, we:scripts/conveyor/review-hold-reconcile.mjs:358, we:scripts/conveyor/review-hold-reconcile.mjs:349-351. Soak-break sketch: wrong-clear: the operator's fresh clearance loses review:accepted and gets a false durable comment; PR then carries neither hold nor accept (planner sees missing review label, RC:2134). Narrow window (two gh calls).

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
