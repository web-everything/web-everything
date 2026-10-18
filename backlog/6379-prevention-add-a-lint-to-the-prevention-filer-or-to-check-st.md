---
bornAs: xa4sdqc
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/6277-prevention-card-template-guidance-a-combinator-guarantee-and.md"]
dateOpened: "2026-10-18"
tags: []
---

# Prevention — Add a lint to the prevention filer, or to check:standards, that flags a new prevention card whose… (from web-everything/web-everything#5553 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/6277-prevention-card-template-guidance-a-combinator-guarantee-and.md:14` — Add a lint to the prevention filer, or to check:standards, that flags a new prevention card whose item text overlaps an open prevention card's gate beyond a threshold. Failing that, have the filer fold new items into one canonical 'card-lint gate' card.
2. `we:backlog/6277-prevention-card-template-guidance-a-combinator-guarantee-and.md:22` — Have the filer label the cross-references 'review finding N' and keep each item's original finding number.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5553@9dd50c27a7d65ea994df5b3ce74ef1f74c30b398

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
