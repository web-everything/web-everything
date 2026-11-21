---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/pr-status-label.mjs", "we:scripts/conveyor/__tests__/pr-status-label-ready-green.test.mjs", "we:skills-src/conveyor/__tests__/review-daemon.test.mjs", "we:scripts/conveyor/__tests__/pr-status-label.test.mjs"]
dateOpened: "2026-11-20"
tags: []
---

# Prevention — Add a branch-coverage or unreachable-code check on pure derivation functions. Alternatively, requ… (from web-everything/web-everything#7258 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/pr-status-label.mjs:160` — Add a branch-coverage or unreachable-code check on pure derivation functions. Alternatively, require each new return path to have a test whose input reaches it.
2. `we:scripts/conveyor/pr-status-label.mjs:160` — Add a test table for derivePrStatusLabel that crosses base branch with required-check state, and make requiredCiGreen share the main-only filter with reviewCiWait.
3. `we:scripts/conveyor/pr-status-label.mjs:78` — Assert `required.length > 0` after filtering and add a test for it. Longer term, a lint rule or helper that rejects `.every()` over a derived list without a non-empty check.
4. `we:scripts/conveyor/pr-status-label.mjs:79` — Add a contract test that feeds a captured real `gh pr view --json statusCheckRollup` payload into derivePrStatusLabel. Alternatively, have the caller stamp each rollup with the head it was read at, and fail closed if the stamp is missing or differs from the live head.
5. `we:scripts/conveyor/__tests__/pr-status-label-ready-green.test.mjs:1` — Parameterize the unknown-list test over [null, undefined, [], [''], [,'x']\]. Optionally add a mutation-testing gate for guard lines in the conveyor.
6. `we:scripts/conveyor/__tests__/pr-status-label-ready-green.test.mjs:25` — Strengthen the named test to assert awaiting-ci and include an explicit unknown check-result case alongside the unknown requirement-list case.
7. `we:skills-src/conveyor/__tests__/review-daemon.test.mjs:669` — Add a deterministic daemon test starting with status:ready-to-merge and pending required CI, asserting removal and replacement with status:awaiting-ci within two ticks.
8. `we:skills-src/conveyor/__tests__/review-daemon.test.mjs:655` — Add the named daemon regression test to the automated test gate, asserting stale readiness removal within two ticks after a required check becomes pending.
9. `we:scripts/conveyor/__tests__/pr-status-label-ready-green.test.mjs:25` — Strengthen 'an unknown required-check list is not ready' to assert awaiting-ci in the automated test gate.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7258@4751c1f9b83d08e616f7a176b88aba37b6e7336f

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
