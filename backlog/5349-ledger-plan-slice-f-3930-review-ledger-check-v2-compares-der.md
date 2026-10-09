---
bornAs: xbm2jo5
kind: task
parent: "2405"
status: resolved
scope: ["we:scripts/review-ledger-check.mjs", "we:scripts/__tests__/review-ledger-check.test.mjs"]
dateOpened: "2026-10-08"
dateResolved: "2026-10-09"
graduatedTo: 72020d9ac050c73b8c78a3995a4940f82d65a051
tags: []
---

# Ledger plan slice F (#3930): review-ledger-check v2 compares derived labels to live labels, appends a run record

Slice F of the verdict-ledger plan. The checker runs derivePrState per open PR and compares its labels to the live labels for every mirrored family (review, ruling-needed, ready-to-merge, ci:failed). It appends one run record to the shared runs folder. Report only: it fixes no labels. Also folds in two #4311 leftovers: tests clear WE_VERDICT_LEDGER_BOARD, and an origin-probe timeout reports unreadable.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
