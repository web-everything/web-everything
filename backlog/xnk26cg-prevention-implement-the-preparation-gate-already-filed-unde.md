---
kind: story
size: 3
parent: "5360"
status: open
scope: ["we:backlog/6360-prevention-add-a-check-standards-rule-or-review-checklist-it.md"]
dateOpened: "2026-10-18"
tags: []
---

# Prevention — Implement the preparation gate already filed under #5360/#5473, validating each obligation indepe… (from web-everything/web-everything#5640 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:
1. `we:backlog/6360-prevention-add-a-check-standards-rule-or-review-checklist-it.md:16` — Implement the preparation gate already filed under #5360/#5473, validating each obligation independently rather than accepting a card because some items have named tests.

Already tracked on open cards (recorded there as "Also raised by", not refiled): finding 1 → #5473, finding 2 → #5473, finding 3 → #5473, finding 5 → #5473.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5640@a8d26e0084341fca9ebd2208228e1e5056bee7f1

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
