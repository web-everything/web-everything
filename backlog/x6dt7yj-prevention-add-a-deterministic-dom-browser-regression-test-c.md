---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:blocks/state-view/StateViewElement.ts", "we:blocks/state-view/__tests__/StateViewElement.test.mjs"]
dateOpened: "2026-11-26"
tags: []
---

# Prevention — Add a deterministic DOM/browser regression test covering mixed text and element children across loading, e… (from frontier-ui/frontierui#56 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:blocks/state-view/StateViewElement.ts:197` — Add a deterministic DOM/browser regression test covering mixed text and element children across loading, error, and ready states.
2. `we:blocks/state-view/StateViewElement.ts:208` — Extend the deterministic focus regression tests to remove the focused control and assert focus reaches a remaining link or summary.
3. `we:blocks/state-view/StateViewElement.ts:14` — When a doc comment states a negative guarantee (X does not count), require a paired negative-case test. A review-lens checklist item is enough.

Idempotency key (do not edit): approval-prevention-key:frontier-ui/frontierui#56@4bc73ebcde79aba07d4e34256fa38d3ddd34d94c

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
