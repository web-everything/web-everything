---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs", "we:scripts/conveyor/reconcile-fix-dispatch.mjs", "we:skills-src/conveyor/__tests__/reconcile-fix-dispatch-daemon.test.mjs", "we:scripts/conveyor/__tests__/reconcile-fix-dispatch.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — Add a unit test for formatRefusalLine with head and readAt set. More generally, a review lens tha… (from web-everything/web-everything#7328 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs:1614` — Add a unit test for formatRefusalLine with head and readAt set. More generally, a review lens that asks for a named test for every behaviour sentence in a PR description would catch this class.
2. `we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs:1614` — Add a deterministic formatter unit test asserting both head= and read= values in the emitted line.
3. `we:scripts/conveyor/reconcile-fix-dispatch.mjs:2024` — Add a parameterized failure-contract test for throwing, deferred, and malformed replans, asserting the original refusal remains and dispatch is never called; include it in the unit-test gate.
4. `we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs:1614` — Add a formatter contract test asserting both metadata values appear in the rendered refusal line and run it in the unit-test gate.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7328@11d7e3f3bb1da98dc7a6055a0404b35f9af3bb63

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
