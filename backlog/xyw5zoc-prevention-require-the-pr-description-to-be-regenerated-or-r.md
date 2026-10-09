---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/pr-state/referrals.mjs", "we:scripts/operations/record-referral-ruling-io.mjs", "we:scripts/lib/pr-state/__tests__/referrals.test.mjs", "we:scripts/operations/__tests__/record-referral-ruling-io.test.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# Prevention — Require the PR description to be regenerated or re-checked against the card's Operator ruling lin… (from web-everything/web-everything#4502 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/pr-state/referrals.mjs:50` — Require the PR description to be regenerated or re-checked against the card's Operator ruling line before the PR is marked ready. A lint that flags description claims naming a function whose diff is comment-only would also catch this.
2. `we:scripts/operations/record-referral-ruling-io.mjs` — Add a deterministic regression test whose append sink persists the first clearing row and then throws; require a compensating block row and assert the final derived state is blocking. Run it in the required test gate.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4502@a11a412d9b62f34bd4d9028aa9ca3d6e210ef661

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
