---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/orphan-fix-round.mjs", "we:scripts/conveyor/__tests__/orphan-fix-round.test.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Prevention — Add a check that fails when PR-description claims about resume or cursor behaviour have no matchi… (from web-everything/web-everything#7429 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/orphan-fix-round.mjs:187` — Add a check that fails when PR-description claims about resume or cursor behaviour have no matching test name. If that's too heavy, a review-lens note that the description must match the final tests. Separately, file a card to remove the 500-PR blind spot with a real persisted or rotating cursor.
2. `we:scripts/conveyor/__tests__/orphan-fix-round.test.mjs:102` — Add a lint or check that resolves test names quoted in a card's Acceptance section against the test files in the diff.
3. `we:scripts/conveyor/orphan-fix-round.mjs:193` — Have the PR-description check require every behavioural claim in PREP to name a test. Alternatively, add a card-lint rule that rejects 'resume' or 'cursor' wording unless the diff contains matching state. Failing that, add a review lens that diffs the description's claims against the test names.
4. `we:scripts/conveyor/orphan-fix-round.mjs:192` — Require any resumption guarantee to have a deterministic multi-pass test asserting discovery beyond the first pass's cap; otherwise describe the tested bounded behavior.
5. `we:scripts/conveyor/orphan-fix-round.mjs:192` — Add a deterministic repeated-pass test with more than 500 open PRs that asserts eventual discovery of a bounced PR on page six; reconcile the acceptance contract with the intended bounded behavior.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7429@e020654633cb2a68dd17537a28fdcc9e631ce6ee

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
