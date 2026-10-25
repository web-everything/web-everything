---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-10-25"
tags: []
---

# The drain rebases approved human-only-surface PRs, which drops the approval every time

[held entry 339] (operator ok 2026-10-14 ~18:15 ET, held, HIGH, option a) The drain rebases approved human-only-surface PRs, which drops the approval every time. #5298 (bca460e2c->7095160f4), #5187 (ec6b37edd->886a077ab), #5253: PR-own patch-id identical, operator re-approved unchanged content 2-3 times. Fix (a): the drain does not rebase an approved human-surface PR with no conflict; the merge queue tests it against latest main anyway. Setting, old behaviour selectable; approval guard untouched. Prove: an approved we:ci.yml PR keeps its head and approval until it lands.

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
