---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/x2sgweq-the-drain-honours-mergegate-reviewauthority-labels-both-ledg.md", "we:backlog/x9qibqz-gradual-ledger-authority-per-fact-type-and-pr-class.md", "we:backlog/xnc1xyl-ledger-shadow-comparison-counts-the-drain-s-own-facts.md"]
dateOpened: "2026-10-17"
tags: []
---

# Prevention — Card template guidance: a combinator guarantee (AND/OR) lists one named test per truth-table row.… (from web-everything/web-everything#5546 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:
1. `we:backlog/x2sgweq-the-drain-honours-mergegate-reviewauthority-labels-both-ledg.md:17` — Card template guidance: a combinator guarantee (AND/OR) lists one named test per truth-table row. A review lens is enough, since a deterministic gate cannot see this.
2. `we:backlog/x9qibqz-gradual-ledger-authority-per-fact-type-and-pr-class.md:17` — Card review lens: every enumerated setting gets its own invalid-value and absent-value test, and every enum member has a definition.
3. `we:backlog/xnc1xyl-ledger-shadow-comparison-counts-the-drain-s-own-facts.md:16` — Card-lint gate: a test list that names fewer tests than the guarantee enumerates items is flagged, and boilerplate edge-case lines are rejected unless they are card-specific.
4. `we:backlog/x9qibqz-gradual-ledger-authority-per-fact-type-and-pr-class.md:33` — Require behavioral guarantee IDs and mechanically validate their mappings to named planned tests and assertions.
5. `we:backlog/x2sgweq-the-drain-honours-mergegate-reviewauthority-labels-both-ledg.md:34` — Require a checked guarantee-to-test matrix that explicitly distinguishes omitted defaults, explicit values, and malformed inputs.
6. `we:backlog/xnc1xyl-ledger-shadow-comparison-counts-the-drain-s-own-facts.md:36` — Require edge entries to be either an explicit non-applicability rationale or a guarantee with a mechanically checked test mapping.

Already tracked on open cards (recorded there as "Also raised by", not refiled): finding 1 → #5590, finding 8 → #5590, finding 12 → #5590, finding 5 → #5473, finding 13 → #5473, finding 10 → #5625, finding 11 → #5360.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5546@98207bf799539ee7d49a5517411533b8ede19ee1

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
