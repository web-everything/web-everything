---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:blocks/state-view/StateViewElement.ts", "we:blocks/state-view/StateView.ts", "we:blocks/state-view/__tests__/StateViewElement.test.mjs", "we:blocks/state-view/__tests__/StateView.test.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Prevention — Add a mandatory unit regression named 'Retry becomes available after a same-state error outcome' using a l… (from frontier-ui/frontierui#56 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:blocks/state-view/StateViewElement.ts:40` — Add a mandatory unit regression named 'Retry becomes available after a same-state error outcome' using a listener that completes its request unsuccessfully.
2. `we:blocks/state-view/StateViewElement.ts:43` — Extend the mandatory single-flight regression to start in error, synchronously enter loading in the listener, advance eight seconds, and assert that only one retry event fires.
3. `we:blocks/state-view/StateViewElement.ts:53` — Add mandatory regressions for once consumption, signal abortion, and registration with an already-aborted signal, asserting the resulting Retry availability.
4. `we:blocks/state-view/StateViewElement.ts:60` — Add a mandatory regression registering one callback in both capture modes and asserting Retry remains enabled after removing only one registration.
5. `we:blocks/state-view/StateViewElement.ts:85` — Add a mandatory focus regression whose Retry listener synchronously enters loading and assert that document.activeElement remains inside the host.
6. `we:blocks/state-view/StateViewElement.ts:151` — Add a mandatory regression with mixed text and element content, asserting authored content is absent from the displayed subtree before ready and restored intact afterward.
7. `we:blocks/state-view/StateViewElement.ts:14` — When a doc comment makes a negative guarantee ('X does not count'), add a test that adds a listener on document or an ancestor and asserts the button stays disabled. This could be a review-lens checklist item for doc-comment guarantees.
8. `we:blocks/state-view/StateView.ts:137` — Add the named unit test to the existing test gate, asserting that explicit slow=true adds one note and sets aria-busy=false, while the omitted default adds no note.
9. `we:blocks/state-view/StateViewElement.ts` — Extend the named single-flight test with a synchronous error-to-loading listener and assert that advancing to the slow stage cannot dispatch a second retry before settlement.
10. `we:blocks/state-view/StateViewElement.ts` — Add a deterministic lifecycle regression test covering error, retry, asynchronous failure in the same state, and a successful second retry dispatch.
11. `we:blocks/state-view/StateViewElement.ts` — Gate listener tracking with parameterized tests for once, already-aborted and later-aborted signals, and separate capture registrations, asserting button availability and actual retry delivery.
12. `we:blocks/state-view/StateViewElement.ts` — Add a parameterized content-visibility regression test containing mixed text and element nodes, verifying that non-ready states hide both and ready restores both.

Idempotency key (do not edit): approval-prevention-key:frontier-ui/frontierui#56@b6be04c819024acc2593092718dce24078c6b998

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
