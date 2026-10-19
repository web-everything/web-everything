---
bornAs: xgtlo2l
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/__tests__/sim-world-env.test.mjs"]
dateOpened: "2026-10-14"
tags: []
---

# Prevention — Add a createWorld test that asserts env.WE_GH_THROTTLE_LOCK_ROOT is world-scoped and differs betw… (from web-everything/web-everything#5253 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/__tests__/sim-world-env.test.mjs:28` — Add a createWorld test that asserts env.WE_GH_THROTTLE_LOCK_ROOT is world-scoped and differs between two worlds. More generally, require a test of the call site whenever a fix is delivered as a helper plus a one-line wiring change.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5253@dea3cb43b247fddee993e941f9677c66258e078e

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
