---
bornAs: xb8gn35
kind: story
size: 5
status: open
scope: ["we:scripts/conveyor/review-referral-hold.mjs"]
dateOpened: "2026-11-15"
tags: []
---

# Judge sweep must rule PRs held review-referrals-pending each pass instead of classifying them noAction

we:scripts/conveyor/review-referral-hold.mjs (2026-11-15 05:11 ET, HIGH): the judge sweep classifies PRs held 'review-referrals-pending' as noAction, so referrals sat unruled for hours (0 merges 05:35-10:10Z). The sweep or a daemon must rule pending referrals per R10/R903 on each pass. Prove on the live case with before/after evidence, not only unit tests.

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
