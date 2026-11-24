---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:blocks/__tests__/unit/state-view/state-view.test.ts", "we:blocks/state-view/state-view.css"]
dateOpened: "2026-11-23"
tags: []
---

# Prevention — Add a table-driven test that asserts the per-state icon markup is non-empty and pairwise distinct. A revie… (from frontier-ui/frontierui#54 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:blocks/__tests__/unit/state-view/state-view.test.ts:15` — Add a table-driven test that asserts the per-state icon markup is non-empty and pairwise distinct. A review-lens note that any prose guarantee about shape needs a content assertion would also help.
2. `we:blocks/__tests__/unit/state-view/state-view.test.ts:35` — A review lens: every 'X only' or 'only when' clause in a doc comment needs a negative test. A deterministic gate is not practical here.
3. `we:blocks/state-view/state-view.css:38` — Add a CSS unit assertion that `.fui-state-view__action:disabled` has a distinct rule, for example reduced emphasis and no pointer cursor. Alternatively, add a review checklist item that any `disabled` state must have a matching `:disabled` style.
4. `we:blocks/__tests__/unit/state-view/state-view.test.ts:14` — Add an element-level security-input test whenever a block takes a URL attribute. Add an svg-presence assertion for each state. A lint cannot decide this, so it belongs in a review-lens checklist item: every prose guarantee in the pre-mortem maps to a named assertion.

Idempotency key (do not edit): approval-prevention-key:frontier-ui/frontierui#54@278fd727f45048d9d3b40d3d2085dc143928a688

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
