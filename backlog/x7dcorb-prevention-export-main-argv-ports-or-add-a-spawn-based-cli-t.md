---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/pr-body-edit.mjs", "we:scripts/__tests__/pr-body-edit.test.mjs"]
dateOpened: "2026-11-27"
tags: []
---

# Prevention — Export main(argv, ports) or add a spawn-based CLI test for each usage and mutual-exclusion branch… (from web-everything/web-everything#7588 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/pr-body-edit.mjs:156` — Export main(argv, ports) or add a spawn-based CLI test for each usage and mutual-exclusion branch. The cheapest durable guard is a standards rule that every usage-refusal branch in scripts/*.mjs needs a test asserting exit 2.
2. `we:scripts/pr-body-edit.mjs:156` — Export `main` or extract the argv parsing into a pure function. Add a test for each usage refusal that checks the exit code 2 and that `append` and `gh` are not called.
3. `we:scripts/pr-body-edit.mjs:59` — Compare `hasStampLostMarker(body)` with `hasStampLostMarker(current)` in the same post-check. Add the unterminated-marker test case for it. A test that tries every marker kind from we:review-independence.mjs would cover the whole class.
4. `we:scripts/pr-body-edit.mjs:158` — Add a table-driven CLI test for both conflicting modes, asserting exit code 2 and no write, and include it in the automated test gate.
5. `we:scripts/pr-body-edit.mjs:158` — Add a deterministic CLI regression test covering both conflicting flags and an empty --append-file value, asserting exit code 2 and no PR operations.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7588@e1b86b9ec4eb66becb363bf09515ef513d8a787e

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
