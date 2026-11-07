---
kind: story
size: 3
status: open
scope: ["we:scripts/lib/advisory-labels.mjs", "we:scripts/conveyor/advisory-label-sweep.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# Late-posted advisory for an older head makes the sweep strip advisory:accepted from the current head

Flow-sim gap B-C10, class K6 (check-then-act race with no pin). Failing input: Head B live, labels review:human + advisory:accepted. Trusted comments in order: advisory(Net basis x..B, 10:00), advisory(Net basis x..A, 10:05) (the slow run for the pre-push head A posted after B's). sweep tick. Cited: we:scripts/lib/advisory-labels.mjs:105-125, we:scripts/conveyor/advisory-label-sweep.mjs:77-83. Soak-break sketch: wrong-clear (advisory:accepted removed from B; PR shows human-review-pending-advisory). Unverified whether the advisory poster refuses to post for a non-live head; if it does this is unreachable.

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
