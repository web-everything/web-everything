---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/__tests__/red-main-quarantine-log-escape.test.mjs"]
dateOpened: "2026-11-22"
tags: []
---

# Prevention — A review lens or card-conformance check that each Acceptance clause maps to a named test assertin… (from web-everything/web-everything#7373 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/__tests__/red-main-quarantine-log-escape.test.mjs:25` — A review lens or card-conformance check that each Acceptance clause maps to a named test asserting the outcome. This is not script-decidable as a gate.
2. `we:scripts/lib/__tests__/red-main-quarantine-log-escape.test.mjs:25` — Add a deterministic probe integration test using the strict gh fixture and asserting the exact failing file in the probe’s structured result.
3. `we:scripts/lib/__tests__/red-main-quarantine-log-escape.test.mjs:25` — Add a deterministic regression test that feeds the strict escape-coded log through the main-ci-red probe's classification path and asserts the exact failing file.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7373@ab718001d93868fc3e3fb0932cdbc6030430f2e3

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
