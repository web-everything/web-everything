---
bornAs: x65meyk
kind: story
size: 3
status: active
scaffoldedBy: "fix-5996"
dateScaffolded: "2026-10-28"
scope: ["we:scripts/lib/duplicate-bornas-added.mjs", "we:scripts/lib/numbering-carry.mjs", "we:scripts/lib/card-group.mjs", "we:scripts/lib/card-conflict-resolve.mjs", "we:scripts/lane-drain.mjs", "we:scripts/operations/sweep-orphan-backlog-cards.mjs"]
dateOpened: "2026-10-28"
tags: []
---

# bornAs readers outside the drain guard grep whole card files, so a body identity example counts as an owned identity (duplicate-bornas-added, numbering-carry, card-group, card-conflict-resolve, lane-drain, sweep-orphan-backlog-cards)

bornAs readers outside the drain guard grep whole card files, so a body identity example counts as an owned identity (duplicate-bornas-added, numbering-carry, card-group, card-conflict-resolve, lane-drain, sweep-orphan-backlog-cards). Filed from a fix or review daemon run that found this gap and left it unlanded.

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
