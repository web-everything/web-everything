---
bornAs: xhlx9bt
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/merge-gate-verdict.mjs", "we:scripts/operations/operator-queue.mjs", "we:scripts/lib/__tests__/merge-gate-verdict.test.mjs", "we:scripts/operations/__tests__/operator-queue.test.mjs"]
dateOpened: "2026-10-12"
tags: []
---

# Prevention — Restrict the ledger excuse to rows whose reason is exactly 'labels: labels hold', or drop ledger… (from web-everything/web-everything#5013 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/merge-gate-verdict.mjs:66` — Restrict the `ledger` excuse to rows whose reason is exactly 'labels: labels hold', or drop `ledger` from the excused set. Add a test that varies the ledger reason. A check:standards rule that every HUMAN_REVIEW_HOLD_GATES member has a reason-bound test would catch the whole class.
2. `we:scripts/operations/operator-queue.mjs:232` — Have readMergeGateVerdict fetch the job's workflow identity, and the run's `path` if needed. Require it to equal the canonical merge-gate workflow file on main, with a test for a mismatched workflow. A deterministic gate is an operator-queue unit test, plus a check:standards rule that any reader which excuses a failed check must assert the producer's workflow identity.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5013@47982f4ac6ccd407ca8eaca1cefb9ebaa9f8c1ad

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
