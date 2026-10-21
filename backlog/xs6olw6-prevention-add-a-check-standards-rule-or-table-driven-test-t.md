---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/review-pr-io.mjs", "we:scripts/review-set-label.mjs", "we:docs/agent/testing.md", "we:scripts/conveyor/advisory-label-sweep.mjs", "we:scripts/operations/__tests__/review-pr-io.test.mjs", "we:scripts/__tests__/review-set-label.test.mjs", "we:scripts/conveyor/__tests__/advisory-label-sweep.test.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Prevention — Add a check:standards rule or table-driven test that every call writing a review hold label also… (from web-everything/web-everything#5482 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/review-pr-io.mjs:1220` — Add a check:standards rule or table-driven test that every call writing a review hold label also names ready-to-merge in its remove set.
2. `we:scripts/review-set-label.mjs:1574` — A CLI argument-validation table test for every flag fail() branch, plus the hold-site strip check above.
3. `we:docs/agent/testing.md:84` — Doc-claim review lens; or narrow the doc sentence to 'removes stale labels'.
4. `we:scripts/conveyor/advisory-label-sweep.mjs:150` — Give the sweep one shared 'complete-thread-or-skip' helper that every label writer must call, and add a lint or standards check that sweep writers do not call setLabels without it.
5. `we:scripts/review-set-label.mjs:1398` — Require a CLI-level test (forged-author marker, wrong-head marker, trusted marker) for each new boolean input to decideSetLabel. A review lens checking that every new decision flag has a wiring test is the cheapest guard.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5482@9507ba7544658207a7ddff01cb3b65f539bfd7d7

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
