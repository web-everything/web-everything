---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/build-delivery-evidence.mjs", "we:scripts/conveyor/__tests__/"]
dateOpened: "2026-10-08"
tags: []
---

# Build delivery evidence: the fixed 100-row PR query can be crowded out by unrelated PRs

Follow-up from #4361 advisory review (operator approved with follow-up cards 2026-10-08). we:scripts/conveyor/build-delivery-evidence.mjs:201 lists at most 100 PRs, so unrelated or fork PRs can push the card's delivery PR out of the window and the build is not seen as delivered. Paginate or narrow the query to the card's lane ref, with a test of more than 100 rows.

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
