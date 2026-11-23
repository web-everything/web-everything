---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/readiness/__tests__/forge-key-structure-unclosed-tail.test.mjs"]
dateOpened: "2026-11-23"
tags: []
---

# Prevention — Add a PR-body lint or review-lens check that each Acceptance bullet names a test and that no test… (from web-everything/web-everything#7355 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/readiness/__tests__/forge-key-structure-unclosed-tail.test.mjs:18` — Add a PR-body lint or review-lens check that each Acceptance bullet names a test and that no test's assertion contradicts the bullet text.
2. `we:scripts/readiness/__tests__/forge-key-structure-unclosed-tail.test.mjs:24` — Require acceptance criteria to reference named tests and their expected outcomes, with a deterministic registry assertion for whichever outcome is adopted.
3. `(no file cited)` — Add a deterministic report check asserting zero new matching runs during the defined observation window, and retain its result with acceptance evidence.
4. `we:scripts/readiness/__tests__/forge-key-structure-unclosed-tail.test.mjs:21` — Require acceptance criteria to reference named tests and reconcile their expected outcomes whenever acceptance changes.
5. `(no file cited)` — Add a named report check that fails on any new matching run during the observation window and retain its result as acceptance evidence.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7355@eb99681d400caa9b22ccfe423509f05ea3725596

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
