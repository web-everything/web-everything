---
bornAs: xpvgt8e
kind: story
size: 1
status: open
scope: ["we:scripts/operations/review-pr.mjs", "we:scripts/operations/__tests__/review-pr-io.test.mjs"]
dateOpened: "2026-10-13"
tags: []
---

# Test the holdGivesWay branch of referralVerdict: a block-ruled referral turns a held accept into changes

PR #5025 review (advisory test-coverage finding, operator ruled card 2026-10-13 ~11:45 ET): the holdGivesWay branch in referralVerdict (we:scripts/operations/review-pr.mjs, ~line 3144) has no test asserting its outcome. When a run has a lone not-reproduced retirement (acceptHeld) AND a block-ruled referral, the verdict must be changes with humanRequired false, so the fixer gets the bounce instead of a human park. The nearby test 'AN INDEPENDENT BLOCK survives a negative verifier answer' in we:scripts/operations/__tests__/review-pr-io.test.mjs only asserts blocked.length and the assertMandatoryReferralsCleared throw. Add assertions run.verdict.verdict === 'changes' and humanRequired === false, and prove they redden when holdGivesWay is forced false (mutation check).

## Acceptance

- [A1] **Executable** — `npm run test:unit -- we:scripts/operations/__tests__/review-pr-io.test.mjs` passes with a test asserting `verdict === 'changes'` and `humanRequired === false` for a run with a lone not-reproduced hold plus a block-ruled referral; forcing `holdGivesWay` to false in `we:scripts/operations/review-pr.mjs` makes that test fail.

## Non-goals

- [N1] No change to `referralVerdict` behaviour itself; this only adds the missing test.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: test-only change, no new input handling.
2. **Truncated reads** — n/a: test-only change.
3. **Shared state files** — n/a: test uses an in-memory harness.
4. **Fail closed** — the test also pins that without a block ruling the held accept stays `needs-human`.
5. **Identity scoping** — n/a: test-only change.
6. **State over time** — n/a: single-run verdict assertion.
7. **Who wrote it** — n/a: test-only change.
