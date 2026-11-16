---
bornAs: xn8yktx
kind: story
size: 8
status: active
scaffoldedBy: "cards-batch-21"
dateScaffolded: "2026-11-16"
scope: ["we:scripts/conveyor/review-pr-io.mjs"]
dateOpened: "2026-11-16"
tags: []
---

# Redesign the review-gate hold exemption from the full merge-gate table (from parked #6874)

From parked #6874 after 5 rounds: verdict publication may ignore a red review-gate only for a review-hold annotation on the current head. The annotation predicate fails when a human hold coexists with a missing or in-progress red-team check (we:scripts/conveyor/review-pr-io.mjs:1072). Redesign the hold classification so candidacy is derived from the full merge-gate table (all holds, including pending or missing red-team), with a fixture per combination (24 inventory rows). Opus design first.

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
