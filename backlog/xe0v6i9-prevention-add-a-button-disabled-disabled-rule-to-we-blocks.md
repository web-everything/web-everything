---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:blocks/state-view/state-view.css", "we:blocks/__tests__/unit/state-view/state-view.test.ts", "we:blocks/state-view/StateView.ts", "we:blocks/state-view/StateViewElement.ts", "we:blocks/state-view/index.ts", "we:blocks/state-view/__tests__/StateView.test.mjs", "we:blocks/state-view/__tests__/StateViewElement.test.mjs", "we:blocks/state-view/__tests__/index.test.mjs"]
dateOpened: "2026-11-23"
tags: []
---

# Prevention — Add a button:disabled / [disabled] rule to we:blocks/state-view/state-view.css and a CSS test that asserts… (from frontier-ui/frontierui#54 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:blocks/state-view/state-view.css:38` — Add a `button:disabled` / `[disabled]` rule to we:blocks/state-view/state-view.css and a CSS test that asserts it exists. Longer term, a check:standards rule that any block CSS styling a `button` also has a `:disabled` selector.
2. `we:blocks/__tests__/unit/state-view/state-view.test.ts:1` — Add an inertness test (a `<img src=x onerror=...>` payload in each copy field, asserting `querySelector('img')` is null). Alternatively, add a lint rule that forbids `innerHTML` in blocks/** except for allow-listed static icon constants.
3. `we:blocks/__tests__/unit/state-view/state-view.test.ts:57` — Test every allowlist guard with a table of accept and refuse cases, including padded and mixed-case variants and each entry point (factory and attribute). Filing a check:standards rule that requires such a table for any isSafeHref-style helper is a possible deterministic gate.
4. `we:blocks/state-view/StateView.ts:72` — Add the named contract tests to the unit-test gate, asserting literal text, state exclusion, exact override/default values, disconnected output, and SVG content.
5. `we:blocks/state-view/StateViewElement.ts:24` — Gate on named tests asserting the missing-state alert and document.activeElement after removing a focused help link.
6. `we:blocks/state-view/StateViewElement.ts:46` — Include the parent-listener assertion in the mandatory unit-test gate.
7. `we:blocks/state-view/index.ts:7` — Gate on a successful custom-tag registration test using an isolated custom-element registry environment.
8. `we:blocks/state-view/StateView.ts:72` — Add a parameterized literal-text regression test for every caller-controlled copy field and require it in the unit-test gate.
9. `we:blocks/state-view/StateViewElement.ts:46` — Add an ancestor-listener assertion to the required unit suite so removing event bubbling fails deterministically.
10. `we:blocks/__tests__/unit/state-view/state-view.test.ts:20` — Add parameterized SVG shape assertions to the required unit suite.
11. `we:blocks/state-view/StateViewElement.ts:24` — Add both branch-specific regression tests to the required unit suite.

Idempotency key (do not edit): approval-prevention-key:frontier-ui/frontierui#54@7af08916faa0756ed023f6d0691da055178ece36

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
