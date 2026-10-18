---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/xrbt66r-prevention-have-the-filer-leave-scope-empty-or-marked-todo-f.md"]
dateOpened: "2026-10-17"
tags: []
---

# Prevention — A check:standards rule that fails a card whose scope paths don't exist on main, or whose scope is… (from web-everything/web-everything#5526 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/xrbt66r-prevention-have-the-filer-leave-scope-empty-or-marked-todo-f.md:6` — A check:standards rule that fails a card whose scope paths don't exist on main, or whose scope is only backlog/ paths on a prevention card. This is the rule the card itself describes.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5526@fc47b475461e25d0e2c37e48a7773439ad45691a

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
