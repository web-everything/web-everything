---
kind: story
size: 2
status: open
scope: ["we:pr-cancelled-rerun.mjs"]
dateOpened: "2026-11-02"
tags: []
---

# (2026-11-02 07:45 ET) xrx3drz (filed uncommitted, may be lost on lane reset)

MED priority hint. - [ ] (2026-11-02 07:45 ET) xrx3drz (filed uncommitted, may be lost on lane reset): lane/ci-heal-rerun-cancelled we:pr-cancelled-rerun.mjs canonical-audit WEAKENED — :373 a superseded run can be revived by the rerun; :395 confirmed API rejections erase the reservation so the same request repeats every sweep. Plus (c) review-hold re-arm after a cancelled-CI rerun needs its own design (explicit review-set-label --to=rearm). Branch lane/required-set-stacked-base holds (a) stacked base borrows main required set when base proven unprotected, (b) one NEEDS-YOU per PR+head.

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
