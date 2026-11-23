---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/orphan-fix-round.mjs", "we:scripts/conveyor/__tests__/orphan-fix-round.test.mjs"]
dateOpened: "2026-11-23"
tags: []
---

# Prevention — Add the missing-PR-head case to we:scripts/conveyor/__tests__/orphan-fix-round.test.mjs. For the… (from web-everything/web-everything#7386 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/orphan-fix-round.mjs:311` — Add the missing-PR-head case to `we:scripts/conveyor/__tests__/orphan-fix-round.test.mjs`. For the general class, a review-lens checklist item: every symmetric equality guard needs a case where both sides are undefined.
2. `we:scripts/conveyor/__tests__/orphan-fix-round.test.mjs:461` — Add a parameterized bounded-pass test asserting expired, mismatched, future-dated, and unknown-current-head entries enter deferred and retain a cursor rather than entering deferredSettled; gate these cases with targeted cache-validity mutations.
3. `we:scripts/conveyor/__tests__/orphan-fix-round.test.mjs:467` — Add a deterministic parameterized test that spends the budget on another uncached PR, then asserts changed-head, expired, missing-head, and future-timestamp entries appear in deferred and the cursor, never deferredSettled.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7386@c5e4a5ff943f915a22e8b7d4318d8b696d666425

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
