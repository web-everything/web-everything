---
bornAs: xd5z1se
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/pr-state-io.mjs", "we:scripts/lib/__tests__/daemon-clone-lock-writer-fairness.test.mjs", "we:scripts/lib/required-check-implication.mjs", "we:scripts/conveyor/reconcile-pass.mjs", "we:scripts/lib/__tests__/pr-state-io.test.mjs", "we:scripts/lib/__tests__/required-check-implication.test.mjs", "we:scripts/conveyor/__tests__/reconcile-pass.test.mjs"]
dateOpened: "2026-10-07"
tags: []
---

# Prevention — Add a table-driven test that runs every required-set consumer (review gate, reduceCheckState, hyd… (from web-everything/web-everything#4283 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/pr-state-io.mjs:109` — Add a table-driven test that runs every required-set consumer (review gate, reduceCheckState, hydrateChecks, pr-state-io) on a rollup containing only a green `test` row against a required set that includes `integration`, so a new consumer must pass it.
2. `we:scripts/lib/__tests__/daemon-clone-lock-writer-fairness.test.mjs:239` — Add a second-episode test: skip, skip, read ok, release, new claim, then expect writer-priority twice again.
3. `we:scripts/lib/required-check-implication.mjs:27` — Add a test that every consumer of the implication refuses an implier row the consumer's own validation would reject (wrong-head, malformed). Also require the implier to appear in the required set before it can imply anything. Longer term, route the implication through the review gate's row validator instead of a second copy.
4. `we:scripts/conveyor/reconcile-pass.mjs:1165` — Add a deterministic hydration regression test containing failed and successful attempts of `test`, absent `integration`, and the default required set; assert the PR remains eligible for review.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4283@76743035c96b0093ce2fe12e8bb57fc7b551df97

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
