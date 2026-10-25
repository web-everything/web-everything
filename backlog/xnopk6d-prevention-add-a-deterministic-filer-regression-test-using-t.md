---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/raised-by/7014/5839-e51ce074d91bc5a2f8a3198c.md"]
dateOpened: "2026-10-25"
tags: []
---

# Prevention — Add a deterministic filer regression test using these distinct prevention requests and destinatio… (from web-everything/web-everything#5902 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:
1. `we:backlog/raised-by/7014/5839-e51ce074d91bc5a2f8a3198c.md:1` — Add a deterministic filer regression test using these distinct prevention requests and destination cards, asserting the exact finding-to-card mapping before raised-by files are emitted.

Already tracked on open cards (recorded there as "Also raised by", not refiled): finding 1 → #5360.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5902@1985be0481e3334359d0c8b63ff4802167b3b4f4

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
