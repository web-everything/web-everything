---
kind: story
size: 1
status: open
scope: ["we:scripts/record-referral-ruling.mjs"]
dateOpened: "2026-11-13"
tags: []
---

# record-referral-ruling: title slice at 90 chars can leave an unmatched code fence and the locus guard refuses the card

2026-11-13 11:13 ET (PR 6754 red-team break, ruled card citing generic card 5337; needs its own card). The title slice at 90 chars in we:scripts/record-referral-ruling.mjs (line 553) can leave an unmatched code fence, so the locus guard refuses the card (fail-closed). Balance or strip fences before slicing.

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
