---
bornAs: xu7yks2
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/3610-how-far-to-take-heavy-command-admission-control-beyond-stage.md"]
dateOpened: "2026-10-25"
tags: []
---

# Prevention — Add a check:standards rule for decision cards: each 'cannot'/'never'/'refuses' guarantee in a pre… (from web-everything/web-everything#5930 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:
1. `we:backlog/3610-how-far-to-take-heavy-command-admission-control-beyond-stage.md:112` — Add a check:standards rule for decision cards: each 'cannot'/'never'/'refuses' guarantee in a prepared card's Done-when must be followed by a `file::test name` reference, or be listed under an explicit 'unmapped' heading.
2. `we:backlog/3610-how-far-to-take-heavy-command-admission-control-beyond-stage.md:120` — Add a check:standards rule for decision cards: every 'cannot', 'never' or 'fails closed' sentence in the proposed-guarantee prose must be matched by a `we:path::case` entry in Done when.

Already tracked on open cards (recorded there as "Also raised by", not refiled): finding 3 → #5473, finding 4 → #5473.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5930@976a02e11ae11dab50d9bc0b54226f07c8fd3225

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
