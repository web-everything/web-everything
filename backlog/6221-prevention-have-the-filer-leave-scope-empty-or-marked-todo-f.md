---
bornAs: xrbt66r
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/x7xiyav-prevention-have-the-filer-qualify-the-reference-pr-finding-9.md"]
dateOpened: "2026-10-17"
tags: []
---

# Prevention — Have the filer leave scope empty or marked TODO for prevention cards, and have a check:standards… (from web-everything/web-everything#5523 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:
1. `we:backlog/x7xiyav-prevention-have-the-filer-qualify-the-reference-pr-finding-9.md:5` — Have the filer leave scope empty or marked TODO for prevention cards, and have a check:standards rule flag a prevention card whose scope contains only backlog/ paths. File this as a backlog item.

Already tracked on open cards (recorded there as "Also raised by", not refiled): finding 2 → #5360.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5523@acd3a05d00953d9f557c0aed3ed1e81e611fca1c

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
