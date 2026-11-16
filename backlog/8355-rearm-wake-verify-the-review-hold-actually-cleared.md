---
bornAs: xhtcphx
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/rearm-review.mjs", "we:scripts/operations/operator-controls.mjs", "we:scripts/conveyor/review-referral-hold.mjs"]
dateOpened: "2026-11-15"
tags: []
---

# Rearm wake: verify the review hold actually cleared

Reinforce-later residual of the rearm same-head pause fix. The wake in we:scripts/conveyor/rearm-review.mjs overrides an active cool-down on no-verdict holds (intended), and its verification in we:scripts/operations/operator-controls.mjs checks wake-comment trust and date but not that the hold in we:scripts/conveyor/review-referral-hold.mjs cleared. Add a check that the hold is gone after the wake, failing closed with an operator-visible note.

## Acceptance

- [A1] **Executable** — `npm run test:unit -- we:scripts/conveyor/__tests__/rearm-review.test.mjs` includes a test where the wake posts but the hold stays, and the rearm reports it as not cleared.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] n/a: no change to the intended cool-down override.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: only reads hold state, no new text is rendered.
2. **Truncated reads** — An unreadable or truncated hold read counts as not cleared.
3. **Shared state files** — n/a: reads the existing hold state only.
4. **Fail closed** — Unknown hold state fails closed with an operator-visible note.
5. **Identity scoping** — The check is per PR number and head sha.
6. **State over time** — The check runs after the wake date, not on stale holds.
7. **Who wrote it** — n/a: author trust is already checked by the wake verification.
