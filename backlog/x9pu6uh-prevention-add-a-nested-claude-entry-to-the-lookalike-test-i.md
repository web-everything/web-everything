---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/urgent-verify.mjs", "we:scripts/operations/__tests__/urgent-verify.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — Add a nested-.claude entry to the lookalike test. In general, require a negative-case test for ea… (from web-everything/web-everything#7287 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/urgent-verify.mjs:33` — Add a nested-`.claude` entry to the lookalike test. In general, require a negative-case test for each predicate clause in a security-adjacent exemption function.
2. `we:scripts/operations/urgent-verify.mjs:21` — Reviewer lens only; no deterministic gate is practical for comment/behavior drift.
3. `we:scripts/operations/urgent-verify.mjs:32` — When a regex or predicate carries an extra rejection clause, add a table-driven negative-case test per clause. Keep comments to behaviour the code implements.
4. `we:scripts/operations/urgent-verify.mjs:26` — Add a deterministic parameterized regression test asserting probe calls for both current-checkout and sibling-checkout lookalikes.
5. `we:scripts/operations/urgent-verify.mjs:30` — Extend the named negative-path test with a sibling-checkout shim and assert that its tool path is probed; run this regression in the existing test gate.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7287@49f86c305db5d35d905335d08dd2bbfdb024d7f4

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
