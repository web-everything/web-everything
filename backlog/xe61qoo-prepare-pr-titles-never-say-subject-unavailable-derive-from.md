---
kind: story
size: 1
status: open
scope: ["we:scripts/operations/machine-pr-title.mjs", "we:scripts/operations/__tests__/machine-pr-title.test.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Prepare PR titles never say subject unavailable: derive from the card title

Coroner 2026-10-07 F8: prepare PRs #4412/#4410/#4408 landed titled '[subject unavailable for N]' because guard-card titles with no numbered finding fell to the placeholder. Derive the subject from the card title instead.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
