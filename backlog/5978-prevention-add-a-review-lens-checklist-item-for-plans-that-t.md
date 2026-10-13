---
bornAs: x0g44ef
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/4648-reconcile-dead-build-run-records-even-after-their-dispatch-c.md"]
dateOpened: "2026-10-12"
tags: []
---

# Prevention — Add a review-lens checklist item for plans that turn tolerant reads into hard failures: it must s… (from web-everything/web-everything#5074 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:
1. `we:backlog/4648-reconcile-dead-build-run-records-even-after-their-dispatch-c.md:32` — Add a review-lens checklist item for plans that turn tolerant reads into hard failures: it must state the persistent-failure behaviour and name a test for it. No deterministic gate fits this class.

Already tracked on open cards (recorded there as "Also raised by", not refiled): finding 2 → #4829.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5074@340b97177af030e050f52a9003c447b00fc6635c

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
