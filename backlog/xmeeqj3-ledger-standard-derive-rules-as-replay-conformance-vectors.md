---
kind: story
size: 3
parent: "5445"
status: open
scope: ["we:conformance-vectors/verdict-ledger-derive.vectors.json", "we:conformance-vectors/verdict-ledger-derive.vectors.ts", "we:scripts/lib/pr-state/__tests__/"]
dateOpened: "2026-10-09"
tags: []
---

# Ledger standard: derive rules as replay conformance vectors

Slice of #5445 (A3, derive half of A1). Write the derive rules (when a hold applies, carry-forward of rulings, what clears a PR to merge) as language-neutral replay vectors: ledger events in, expected derived state and can-merge out. Seed from the existing replays in we:scripts/lib/pr-state/__tests__/pr-state.test.mjs (plateau-app #202, #3964) plus the #3771 and #3988 same-head cases. Done when a runner feeds every vector through derivePrState in we:scripts/lib/pr-state.mjs and all pass, and a mutated rule (for example dropping ruling carry-forward) fails at least one vector.

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
