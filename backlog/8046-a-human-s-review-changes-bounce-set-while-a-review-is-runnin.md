---
bornAs: xf6qcq6
kind: story
size: 3
status: open
scope: ["we:scripts/operations/review-pr.mjs", "we:scripts/operations/review-pr-io.mjs", "we:scripts/review-set-label.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# A human's review:changes bounce set while a review is running is stripped by the agent accept

Flow-sim gap A-C6, class K6 (check-then-act race with no pin). Failing input: labels: [review:pending] files: 'review job running on head H1 (read at T0, panel takes ~20 min); run record read.labels = [review:pending]' operator bounces H1 via review-set-label --to=changes (adds review:changes, removes review:pending) at T0+10 min; panel then accepts Cited: we:scripts/operations/review-pr.mjs:2141, we:scripts/operations/review-pr-io.mjs:1583-1604, we:scripts/review-set-label.mjs:1333-1337, we:scripts/review-set-label.mjs:684-692, we:scripts/review-set-label.mjs:756-758. Soak-break sketch: wrong-clear: the human bounce is removed and review:accepted added; drain may merge. (Intentional for a stale changes from a bounce that was fixed, #2974 at RSL:665-683, but indistinguishable here from a bounce that arrived during the review.)

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
