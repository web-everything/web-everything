---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/readiness/__tests__/heavy-admission-run-ceiling.test.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Prevention — Add a deterministic named test asserting that zero and negative PIDs throw before any process pro… (from web-everything/web-everything#7523 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/readiness/__tests__/heavy-admission-run-ceiling.test.mjs:20` — Add a deterministic named test asserting that zero and negative PIDs throw before any process probe; include it in the normal test gate.
2. `we:scripts/readiness/__tests__/heavy-admission-run-ceiling.test.mjs:20` — Add a one-line unit assertion `expect(() => isDead(0)).toThrow()` if the helper is kept. Alternatively, drop the redundant guard and rely on the caller assertion. No deterministic gate is warranted for a test-helper nit.
3. `we:scripts/readiness/__tests__/heavy-admission-run-ceiling.test.mjs:20` — Add a deterministic named test asserting that zero and negative PIDs throw before any process probe, and run it in the existing test gate.
4. `we:scripts/readiness/__tests__/heavy-admission-run-ceiling.test.mjs:20` — Add a deterministic invalid-PID test asserting that zero and negative inputs throw before any process probe; include it in the normal test gate.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7523@3e952628c97eac06ace5ec1e0e9445c60c3f7995

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
