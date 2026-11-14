---
bornAs: xwbkjev
kind: task
status: open
scope: ["we:scripts/operations/operator-why.mjs"]
dateOpened: "2026-11-14"
tags: []
---

# The why operation names the fix daemon as owner when a send-back is recorded

we:scripts/operations/operator-why.mjs:32 reports owner operator and 'waiting for: human review / park' for any review:human PR, even when an operator send-back is recorded and a fixer is live or fix-cap-held. It misled the babysitting pass on PRs #6713 and #6719 (2026-11-13). When the latest verdict is a send-back, report owner fix daemon and show the live fixer or the fix-cap refusal. Red-first test.

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

Checked with capability-search and a backlog scan on 2026-11-14; no open card covers this exact change.
