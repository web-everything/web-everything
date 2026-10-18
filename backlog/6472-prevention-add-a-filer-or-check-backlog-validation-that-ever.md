---
bornAs: xgia2pv
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/x7llnqo-prevention-add-a-deterministic-filer-validation-that-flags-s.md"]
dateOpened: "2026-10-17"
tags: []
---

# Prevention — Add a filer or check-backlog validation that every scope path either exists on main or is marked… (from web-everything/web-everything#5561 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:
1. `we:backlog/6278-prevention-add-a-deterministic-filer-validation-that-flags-s.md:6` — Add a filer or check-backlog validation that every `scope` path either exists on main or is marked as pending an unmerged PR.

Already tracked on open cards (recorded there as "Also raised by", not refiled): finding 2 → #5360, finding 3 → #5360, finding 4 → #6278.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5561@a1b4e74e7fa0f29294dc4abe760a84a07a3a2e28

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
