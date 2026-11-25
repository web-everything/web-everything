---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/reconcile-fix-dispatch.mjs", "we:scripts/conveyor/__tests__/landing-holder-blocked-state.test.mjs", "we:scripts/conveyor/__tests__/scope-overlap-aging.test.mjs", "we:scripts/conveyor/__tests__/reconcile-fix-dispatch.test.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Prevention — Add a test that makes write() throw across two passes and asserts the second pass still reports t… (from web-everything/web-everything#7501 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/reconcile-fix-dispatch.mjs:2268` — Add a test that makes write() throw across two passes and asserts the second pass still reports the holder. Alternatively, keep an in-process clock fallback so a write failure cannot reset the clock.
2. `we:scripts/conveyor/__tests__/landing-holder-blocked-state.test.mjs:40` — Review lens: a test that names a code path must show that path reaches the guarded call, for example by asserting state.read was called.
3. `we:scripts/conveyor/reconcile-fix-dispatch.mjs:2271` — Add a shell-level test with a throwing `write`. Optionally have the shell escalate or log loudly when the clock write fails repeatedly.
4. `we:scripts/conveyor/__tests__/scope-overlap-aging.test.mjs:78` — Add one bypass-versus-landing-holder test case. A parameterised matrix of bypass mode against holder kind would catch the whole class.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7501@c84b66961da4193f949dbc28b1a3e5d81a9a1e9f

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
