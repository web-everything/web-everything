---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:blocks/state-view/state-view.css", "we:blocks/state-view/StateViewElement.ts", "we:blocks/__tests__/unit/state-view/state-view.test.ts", "we:blocks/state-view/__tests__/StateViewElement.test.mjs"]
dateOpened: "2026-11-23"
tags: []
---

# Prevention — Add a CSS unit test that requires a .fui-state-view__action:disabled rule. Longer term, add a lint/standar… (from frontier-ui/frontierui#54 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:blocks/state-view/state-view.css:38` — Add a CSS unit test that requires a `.fui-state-view__action:disabled` rule. Longer term, add a lint/standards rule that any block styling `button` backgrounds must also define `:disabled`.
2. `we:blocks/state-view/StateViewElement.ts:38` — Add a test that opens details, updates an attribute, and asserts `details.open` is still true. Alternatively, patch the existing DOM instead of replacing it wholesale.
3. `we:blocks/__tests__/unit/state-view/state-view.test.ts:62` — Add a shared table-driven href-safety test helper. It would assert the full allowed and refused scheme matrix and obfuscation variants for any block that renders a caller-supplied href. A check:standards rule could flag blocks that assign `.href` from config without importing the shared safe-href helper.

Idempotency key (do not edit): approval-prevention-key:frontier-ui/frontierui#54@4cadce2ae701c64466bac95714f6e9d09c2fbae9

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
