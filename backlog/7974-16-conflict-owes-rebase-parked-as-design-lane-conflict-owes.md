---
bornAs: xyj73f7
kind: story
size: 2
status: open
scope: ["we:reconcile-core.mjs"]
dateOpened: "2026-11-02"
tags: []
---

# #16 conflict-owes-rebase PARKED as design (lane/conflict-owes-rebase a247209ea2, 1040 tests)

HIGH priority hint. - (HIGH, 11-02 09:21 ET) #16 conflict-owes-rebase PARKED as design (lane/conflict-owes-rebase a247209ea2, 1040 tests): 5 audit rounds, each a new entry path skipping shared holds (latest we:reconcile-core.mjs:2732 stacked CONFLICTING PR skips draft/referral/scope/containment holds). Root cause: each new population gets its own dispatch path. Redesign: ONE shared dispatch-eligibility gate (draft, referral, scope, containment, read-failure HOLD) that every rebase/fix population must pass; #16 only adds the population to that gate. Pre-existing (R412): cap counts completions not attempts (main we:reconcile-core.mjs:3683).

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
