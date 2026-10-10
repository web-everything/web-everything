---
bornAs: xhiufq1
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/verify-lane.mjs", "we:scripts/lib/lane-verify.mjs", "we:scripts/lib/__tests__/verify-since-last-green.test.mjs", "we:scripts/__tests__/verify-lane.test.mjs", "we:scripts/lib/__tests__/lane-verify.test.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# Prevention — Add a verify-lane e2e case that verifies with an uncommitted edit and asserts the ledger director… (from web-everything/web-everything#4732 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/verify-lane.mjs:326` — Add a verify-lane e2e case that verifies with an uncommitted edit and asserts the ledger directory stays empty. More generally, when a guard is split into a pure predicate plus an IO input, test the IO input's negative case too.
2. `we:scripts/lib/lane-verify.mjs:148` — Reword the comment and card to say the ledger is advisory and CI is the only backstop. Optionally add a `repo` and `recordedAt` freshness check in `hasGreenLedger`, or a `check:standards` rule that fails when a doc comment claims 'never blesses a landing' with no named test.
3. `we:scripts/lib/__tests__/verify-since-last-green.test.mjs:232` — For each clause of a validation predicate, require a test that fails with that clause removed, enforced by a mutation spot-check in review.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4732@bff4236adec907e05e23e2fb148c413b30b1ae36

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
