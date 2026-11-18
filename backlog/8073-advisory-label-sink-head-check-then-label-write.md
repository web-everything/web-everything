---
bornAs: x3g7x2k
kind: story
size: 2
status: open
scope: ["we:scripts/operations/review-pr-io.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# ADVISORY_LABEL sink head check then label write

Flow-sim gap R4-G7, class K6 (check-then-act race with no pin). Failing input: review:human PR, advisory outcome for head H. push of H2 after readPrState and before setLabels. Cited: we:scripts/operations/review-pr-io.mjs:1818-1834. Soak-break sketch: stale advisory:accepted on H2 until advisory-label-sweep drops it (sweep exists, ~one tick; delegated-clear-human treats advisory:accepted as label-only, seg C), narrow window.

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
