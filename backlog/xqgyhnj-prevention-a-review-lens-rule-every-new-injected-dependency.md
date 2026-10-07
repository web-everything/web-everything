---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/agent-activity-io.mjs", "we:scripts/operations/sessions.mjs", "we:scripts/operations/__tests__/sessions.test.mjs", "we:scripts/operations/__tests__/agent-activity-io.test.mjs"]
dateOpened: "2026-10-07"
tags: []
---

# Prevention — A review-lens rule: every new injected dependency on a reader factory needs a test that injects i… (from web-everything/web-everything#4350 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/agent-activity-io.mjs:343` — A review-lens rule: every new injected dependency on a reader factory needs a test that injects it and asserts its effect on the output rows.
2. `we:scripts/operations/sessions.mjs:67` — Add a deterministic projection test covering card-backed and PR-only rows, asserting that PR-only rows retain pr and have card:null.
3. `we:scripts/operations/__tests__/sessions.test.mjs:52` — Add an exact output assertion for a fixture containing transcriptPath, so introducing any transcript path field fails the test.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4350@b7111960cc2bfa3836701f2d4ed8eeb7e18d7989

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
