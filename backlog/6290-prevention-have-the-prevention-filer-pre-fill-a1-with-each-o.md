---
bornAs: xpjqial
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/6281-prevention-a-check-standards-rule-that-any-conveyor-module-w.md"]
dateOpened: "2026-10-18"
tags: []
---

# Prevention — Have the prevention filer pre-fill A1 with each owed guard as a separate [A#] line. Alternatively… (from web-everything/web-everything#5576 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:
1. `we:backlog/6281-prevention-a-check-standards-rule-that-any-conveyor-module-w.md:24` — Have the prevention filer pre-fill A1 with each owed guard as a separate [A#] line. Alternatively, add a check:standards rule that rejects status:open prevention cards whose Acceptance still contains the 'TODO: a command that fails' placeholder at the time they are picked up.

Already tracked on open cards (recorded there as "Also raised by", not refiled): finding 2 → #5473, finding 3 → #5615.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5576@9fee24235531fcfdce45f8845f33acbefe22d892

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
