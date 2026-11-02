---
bornAs: x58b1yl
kind: story
size: 3
status: open
scope: ["we:scripts/verify-lane.mjs", "we:scripts/operations/run.mjs"]
dateOpened: "2026-11-01"
tags: []
---

# declared verify operation finishes the verify-lane marker open-pr reads

Held card 2026-11-01 13:12 ET (R332). The verify operation in we:scripts/operations/run.mjs completes but leaves the verify-lane marker UNFINISHED, so open-pr refuses with verify-unfinished. Fix: the verify operation writes/finishes the same marker open-pr reads (we:scripts/verify-lane.mjs), or open-pr accepts the operation run record.

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
