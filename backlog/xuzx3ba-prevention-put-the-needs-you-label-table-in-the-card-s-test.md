---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:src/delivery/delivery-model.ts", "we:wip-relay.js", "we:tests/e2e/delivery.spec.ts", "we:src/delivery/__tests__/delivery-model.test.mjs", "we:./__tests__/wip-relay.test.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Prevention — Put the "needs you" label table in the card's Test plan and assert it against a real-data fixture, for ex… (from plateauapp/plateau-app#232 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:src/delivery/delivery-model.ts:28` — Put the "needs you" label table in the card's Test plan and assert it against a real-data fixture, for example a count of sun chips.
2. `we:wip-relay.js:730` — Add a direct `new WipRelay(...).fetch(PUT /delivery)` test with an oversized body expecting 413. Longer term, a rule that every `json(413...)` branch has a test hitting it.
3. `we:tests/e2e/delivery.spec.ts:40` — Add an axe assertion for both the page and open dialog to the deterministic E2E acceptance suite.

Idempotency key (do not edit): approval-prevention-key:plateauapp/plateau-app#232@497932594fa65a0695cd429104c34deac528451d

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
