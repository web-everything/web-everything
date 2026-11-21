---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/operator-override.mjs", "we:scripts/lib/operator-enum-store.mjs", "we:scripts/lib/operator-override-store.mjs", "we:scripts/operations/__tests__/operator-override.test.mjs", "we:scripts/lib/__tests__/operator-enum-store.test.mjs", "we:scripts/lib/__tests__/operator-override-store.test.mjs"]
dateOpened: "2026-11-20"
tags: []
---

# Prevention — Add a write-gate that requires each Acceptance bullet in the PR body to map to a named test. A ch… (from web-everything/web-everything#7253 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/operator-override.mjs:1` — Add a write-gate that requires each Acceptance bullet in the PR body to map to a named test. A cheaper stopgap is a review-lens checklist item: after any store-layout change, re-verify every reader (show included) against the new layout.
2. `we:scripts/operations/operator-override.mjs` — Add a lint/check that every Acceptance bullet naming a command output maps to a named test. Short term, add an http-adapter test for show-after-set-enum, or drop the claim from Acceptance.
3. `we:scripts/lib/operator-enum-store.mjs:28` — Add a shared fixture-driven test table for strict-store readers (symlink, oversize, FIFO, corrupt) and run it against both the numeric and enum readers, so a new store inherits the negatives.
4. `we:scripts/lib/operator-enum-store.mjs:27` — Add deterministic filesystem-boundary tests, including an asserted read budget, to the required enum suite.
5. `we:scripts/lib/operator-override-store.mjs:60` — Run a shared transaction-contract test suite against both numeric and enum publishers in CI, including contention and injected I/O failures.
6. `we:scripts/lib/operator-override-store.mjs:65` — Add a deterministic CLI integration test that sets an enum and asserts operator-override-show includes its key and value.
7. `we:scripts/lib/operator-enum-store.mjs:27` — Add deterministic filesystem-boundary tests and a targeted mutation gate requiring removal of each reader protection to fail its named test.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7253@6840f9f3c81ac6fc351e13377df483058b8b46ec

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
