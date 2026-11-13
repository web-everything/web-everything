---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/__tests__"]
dateOpened: "2026-11-13"
tags: []
---

# Token- and key-shaped literals in test files force local runs; build fakes at runtime and add a write-time guard

2026-11-13 (21:15 and 2026-11-13 PR 6719 fixer). Tests with literal GitHub-token-shaped fakes or PEM blocks trip the bundle scanner and force local runs, and a fixer commit added one that Forge correctly refused (HARD LINE). Seen in we:scripts/conveyor/__tests__/ci-red-recovery-watch.test.mjs, we:scripts/conveyor/__tests__/reconcile-fix-dispatch.test.mjs and we:scripts/conveyor/__tests__/git-bundle-transport.test.mjs. Build every fake token or PEM at runtime from split string parts, add a check:standards rule that refuses literal credential-shaped strings in test files plus a write-time guard, and tell the fixer brief so.

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

## Duplicate admission

capability-search found no matching open card
