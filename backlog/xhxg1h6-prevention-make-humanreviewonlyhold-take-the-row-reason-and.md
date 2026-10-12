---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/merge-gate-verdict.mjs", "we:scripts/operations/operator-queue.mjs", "we:scripts/lib/__tests__/merge-gate-verdict.test.mjs", "we:scripts/operations/__tests__/operator-queue.test.mjs"]
dateOpened: "2026-10-12"
tags: []
---

# Prevention — Make humanReviewOnlyHold take the row reason and excuse ledger only when it starts with 'labels:'… (from web-everything/web-everything#5013 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/merge-gate-verdict.mjs:52` — Make humanReviewOnlyHold take the row reason and excuse `ledger` only when it starts with 'labels:'. Add a unit test for ledger/both authority holds staying blocking.
2. `we:scripts/operations/operator-queue.mjs:240` — Have the reader also fetch the run (actions/runs/<id>) and require path == we:.github/workflows/merge-gate.yml and the expected event. Add a table-driven test of hostile job and run metadata. For the class, a write-gate or lint could flag any reader that consumes CI log text without asserting workflow identity.
3. `we:scripts/lib/merge-gate-verdict.mjs:55` — Either require the ledger reason to start with 'labels:' or drop ledger from the excusable set. Add a test that a non-label ledger hold stays blocking. For the class, check that every guarantee stated in prose has a matching named test.
4. `we:scripts/lib/__tests__/merge-gate-verdict.test.mjs:26` — Use complete inventory fixtures with exactly one malformed condition, assert the specific rejection reason, and gate these parser validations with targeted mutation tests.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5013@7bfc29b998e6bf8e812eafe1f264de929b000bfe

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
