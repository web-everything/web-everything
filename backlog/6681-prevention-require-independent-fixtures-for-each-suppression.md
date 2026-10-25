---
bornAs: x8js7c9
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/6308-no-fixer-pass-on-a-pr-the-operator-has-already-approved-for.md"]
dateOpened: "2026-10-18"
tags: []
---

# Prevention — Require independent fixtures for each suppression condition and a mutation check that removing ea… (from web-everything/web-everything#5619 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:
1. `we:backlog/6308-no-fixer-pass-on-a-pr-the-operator-has-already-approved-for.md:16` — Require independent fixtures for each suppression condition and a mutation check that removing each guard fails its corresponding named test.

Already tracked on open cards (recorded there as "Also raised by", not refiled): finding 1 → #5473.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5619@e5a2f69dfb555f273084296a12119bd2da22c4f6

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
