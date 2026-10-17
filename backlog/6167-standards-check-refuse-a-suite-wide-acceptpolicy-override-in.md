---
bornAs: xsgfmiv
kind: story
size: 2
status: active
scaffoldedBy: "fix-5393"
dateScaffolded: "2026-10-15"
scope: ["we:scripts/check-standards.mjs", "we:scripts/operations/__tests__/review-loop-cli.test.mjs"]
dateOpened: "2026-10-15"
tags: []
---

# Standards check: refuse a suite-wide acceptPolicy override in review-loop tests

PR #5393 review: review-loop-cli tests wrap runReviewLoopOnce with acceptPolicy unattendedAcceptRequiresCleanReferrals=false for the whole suite, so the round-cards accept path regressed under the default policy with no test reddening. Make the legacy disabled-policy wrapper opt-in per test and add a check:standards rule that fails on a suite-wide acceptPolicy false override, so the production default is what review-loop tests exercise.

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
