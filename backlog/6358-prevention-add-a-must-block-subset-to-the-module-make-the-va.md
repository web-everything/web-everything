---
bornAs: x4y11jy
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/review-stringency-classes.mjs", "we:scripts/lib/__tests__/review-stringency-classes.test.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Prevention — Add a MUST_BLOCK subset to the module, make the validator require disposition 'blocker' for it, a… (from web-everything/web-everything#5516 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/review-stringency-classes.mjs:101` — Add a MUST_BLOCK subset to the module, make the validator require disposition 'blocker' for it, and add a test that downgrades each such class and expects a throw. Alternatively, do this in the slice that adds the evaluator.
2. `we:scripts/lib/__tests__/review-stringency-classes.test.mjs:48` — Add a test with Symbol('x') and Object.defineProperty(..., {enumerable:false}) extra keys, each expecting an unknown class error.
3. `we:scripts/lib/review-stringency-classes.mjs:110` — Add a deterministic isolated-import test that injects invalid definition data and asserts import rejection, then confirm removing the startup call makes that named test fail.
4. `we:scripts/lib/review-stringency-classes.mjs:111` — Add the isolated import rejection test and a targeted mutation check that removes the module-level validation call and requires that named test to fail.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5516@72a514b7b9c97b486cf5d67484c5c290b88e82c6

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
