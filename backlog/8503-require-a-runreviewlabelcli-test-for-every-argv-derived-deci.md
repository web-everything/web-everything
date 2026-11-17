---
bornAs: xo1dpd3
kind: story
size: 3
status: active
scaffoldedBy: "fix-6771"
dateScaffolded: "2026-11-13"
scope: ["we:scripts/review-set-label.mjs", "we:scripts/__tests__/review-set-label.test.mjs"]
dateOpened: "2026-11-13"
tags: []
related: ["6771"]
---

# Require a runReviewLabelCli test for every argv-derived decideSetLabel input

PR 6771 review: the CLI line deriving operatorRestamp from --actor/--to had no CLI-level test, only decider tests with the flag passed by hand, so a mutation stayed green. Add a deterministic check (lint or check:standards rule) that flags a new decideSetLabel option computed from argv in runReviewLabelCli without a matching runReviewLabelCli test asserting the setLabels payload.

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

## Duplicate admission

prevention owed by the PR 6771 review
