---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/readiness/forge-key-structure.mjs", "we:scripts/readiness/__tests__/forge-key-structure.test.mjs"]
dateOpened: "2026-11-20"
tags: []
---

# Prevention — Add a test that feeds each candidate-producing shape (escaped JWK string, hex, base64) inside an… (from web-everything/web-everything#7228 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/readiness/forge-key-structure.mjs:172` — Add a test that feeds each candidate-producing shape (escaped JWK string, hex, base64) inside an unclosed block comment and asserts a finding. Longer term, add a table-driven test asserting that every view-producing path has a 'also inside an unclosed comment' variant.
2. `we:scripts/readiness/forge-key-structure.mjs:160` — Add a detection-parity test matrix to we:forge-key-structure.test.mjs that runs every encoding (plain, JSON-escaped, base64, byte array) under each wrapper (none, closed comment, unclosed comment, line comment) and expects a finding. Longer term, a rule that any perf-motivated skip of a scan path must ship with a test showing detection parity.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7228@06065c041ae5957757d7a08c9da4b88619296a08

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
