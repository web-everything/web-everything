---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lane-pool.mjs", "we:scripts/__tests__/lane-pool.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — Add a Tier 1 case that runs branch with no --pool, with the fixture pool dir named after the orig… (from web-everything/web-everything#7246 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lane-pool.mjs:5960` — Add a Tier 1 case that runs `branch` with no --pool, with the fixture pool dir named after the origin basename. Assert exit 0 and the created branch. Prefer a gate that flags a flag-scrub or override in resolveRepo callers when the test file has no omitted-flag case.
2. `we:scripts/lane-pool.mjs:5619` — Insert new commands after the previous function's closing brace and before the next function's leading comment block. A lint rule for a comment block detached from its function is possible but not worth building.
3. `we:scripts/lane-pool.mjs:5649` — Run mutation testing, or a per-clause refusal-test convention, on the lane-pool containment checks. Each disjunct of a refusal predicate should have a test that only that disjunct can fail.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7246@1abbab627ca5952c24c07f2bb29b877faa908bf7

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
