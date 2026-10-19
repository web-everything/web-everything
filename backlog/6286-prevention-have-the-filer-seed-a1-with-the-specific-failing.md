---
bornAs: xd0axov
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/6241-prevention-a-check-backlog-rule-that-rejects-todo-placeholde.md", "we:backlog/5590-prevention-add-a-check-standards-rule-for-backlog-cards-ever.md"]
dateOpened: "2026-10-18"
tags: []
---

# Prevention — Have the filer seed A1 with the specific failing-then-passing command, for example a check-backlo… (from web-everything/web-everything#5539 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:
1. `we:backlog/6241-prevention-a-check-backlog-rule-that-rejects-todo-placeholde.md:22` — Have the filer seed A1 with the specific failing-then-passing command, for example a check-backlog-item test name. The rule this card asks for would also make a TODO-bearing card fail once it leaves open.
2. `we:backlog/5590-prevention-add-a-check-standards-rule-for-backlog-cards-ever.md:51` — Make the append helper idempotent on the heading: find the existing `## Also raised by` section and add a bullet. Add a check-backlog rule that rejects duplicate H2 headings.
3. `we:backlog/6241-prevention-a-check-backlog-rule-that-rejects-todo-placeholde.md:12` — Run a dedupe pass after filing that cross-links cards whose guard descriptions overlap. At minimum, add a 'see also #4858' line to 6241.

Already tracked on open cards (recorded there as "Also raised by", not refiled): finding 4 → #5473, finding 5 → #5360.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5539@939e90669f43979260588949acfac542a8e69b63

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
