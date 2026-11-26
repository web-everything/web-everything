---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:blocks/state-view/StateViewElement.ts", "we:blocks/state-view/__tests__/StateViewElement.test.mjs"]
dateOpened: "2026-11-26"
tags: []
---

# Prevention — Add a deterministic unit-test gate asserting that direct text and content inserted after mounting remain h… (from frontier-ui/frontierui#56 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:blocks/state-view/StateViewElement.ts:197` — Add a deterministic unit-test gate asserting that direct text and content inserted after mounting remain hidden until ready.
2. `we:blocks/state-view/StateViewElement.ts:208` — Gate focus restoration with a regression test covering removal of the focused control when remaining actions are disabled, asserting focus remains inside the component.
3. `we:blocks/state-view/StateViewElement.ts:14` — A review lens check that every 'does not X' sentence in a header comment has a matching negative-case test. This is not worth a deterministic gate.
4. `we:blocks/state-view/StateViewElement.ts` — Add a deterministic DOM regression test covering direct text and element insertion during pending, loading, and error states without forcing another render.
5. `we:blocks/state-view/StateViewElement.ts` — Add a deterministic focus regression test whose retry listener crosses an await boundary before entering loading, asserting focus containment throughout the pending stage.

Idempotency key (do not edit): approval-prevention-key:frontier-ui/frontierui#56@ed6db5363272913f6f1008a52a985ae2429f7e34

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
