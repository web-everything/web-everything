---
bornAs: x1ownsp
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/xylfibs-quiet-hours-digest-never-lose-held-alerts-oversized-stranded.md"]
dateOpened: "2026-10-09"
tags: []
---

# Prevention — Add a check:standards rule that rejects a card whose status moves from open to in-progress while… (from web-everything/web-everything#4634 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/xylfibs-quiet-hours-digest-never-lose-held-alerts-oversized-stranded.md:17` — Add a check:standards rule that rejects a card whose status moves from open to in-progress while any 'TODO:' placeholder remains in Acceptance, Non-goals or Edge cases. Optionally also require the Risks and Test plan headings for cards that touch alert or notification delivery.
2. `we:backlog/xylfibs-quiet-hours-digest-never-lose-held-alerts-oversized-stranded.md:16` — Add a deterministic backlog validation gate rejecting TODO-only executable acceptance, and require each behavioral guarantee to identify a repository-qualified planned test, case name, and observable assertion.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4634@2b71f2cfa8fd4cc1dffc74d46bdb96de47f09de6

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
