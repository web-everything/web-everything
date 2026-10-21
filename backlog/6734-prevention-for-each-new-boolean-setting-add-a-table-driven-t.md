---
bornAs: xj7ygcm
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/record-referral-ruling-io.mjs", "we:scripts/operations/__tests__/record-referral-ruling-io.test.mjs"]
dateOpened: "2026-10-16"
tags: []
---

# Prevention — For each new boolean setting, add a table-driven test that flips it and asserts the guarded behav… (from web-everything/web-everything#5448 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/record-referral-ruling-io.mjs:134` — For each new boolean setting, add a table-driven test that flips it and asserts the guarded behaviour reverses, at the consumer rather than at the resolver.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5448@6277fc7dfc4b7fc6b1341d46060f2a902bd05eab

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
