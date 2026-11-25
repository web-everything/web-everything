---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/hotpatch-readers.mjs", "we:scripts/lib/hotpatch-guards.mjs", "we:scripts/lib/__tests__/hotpatch-readers.test.mjs", "we:scripts/lib/__tests__/hotpatch-guards.test.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Prevention — Add a deterministic test that feeds the repository's real we:.github/workflows/ci.yml through the… (from web-everything/web-everything#7466 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/hotpatch-readers.mjs:85` — Add a deterministic test that feeds the repository's real we:.github/workflows/ci.yml through the fullSuite matrix parser and fails when it cannot derive the expected legs. File it with the RS-HP-2 wiring condition.
2. `we:scripts/lib/hotpatch-readers.mjs:119` — Add a reader test with a real or fixture git graph: an app-only head behind a main that changed an unrelated scripts/ file, asserting the intended outcome. Compare only actual CI-definition inputs for divergence, or return a distinct 'rebase needed' result.
3. `we:scripts/lib/hotpatch-readers.mjs:31` — Add a test that runs several admissions on one reader with a realistic job count, and reset the budget per admission.
4. `we:scripts/lib/hotpatch-readers.mjs:156` — Add reader tests that set a platform preference and each env variable and assert the resolved layers and the admission outcome.
5. `we:scripts/lib/hotpatch-guards.mjs:47` — Add one targeted case per branch asserting the exact outcome, or run a mutation check on new guard modules.
6. `we:scripts/lib/hotpatch-guards.mjs:98` — Extend ciControlFiles to extract file paths from playwright webServer.command (and similar config command strings) so the closure test fails until the guard denies them. File it with the RS-HP-2 wiring conditions.
7. `we:scripts/lib/hotpatch-readers.mjs:54` — Add a test that changes preferences between two admissions on the same reader and asserts the new value is honoured, and read preferences per call.
8. `we:scripts/lib/hotpatch-guards.mjs:75` — Add one negative case per refusal branch, or run a mutation pass over guard modules as a gate before wiring.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7466@68a3959e3000eaaaa4574e6bfa93fc700cf11dc2

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
