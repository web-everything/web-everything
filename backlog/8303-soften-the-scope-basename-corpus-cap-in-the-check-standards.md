---
bornAs: x2yhhtu
kind: story
size: 3
status: active
scaffoldedBy: "fix-scope-basenames"
dateScaffolded: "2026-11-14"
scope: ["we:scripts/__tests__/check-standards.test.mjs"]
dateOpened: "2026-11-14"
tags: []
---

# Soften the scope-basename corpus cap in the check-standards test

The test at we:scripts/__tests__/check-standards.test.mjs line 545 hard-caps the live backlog scope-basename mismatch count below 30. Ordinary card filing pushed it to 30 and failed every merge group. Make the gate warn above a setting-driven threshold, and have the test assert the rule on a fixture plus a much higher sanity cap.

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
