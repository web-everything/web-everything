---
bornAs: x6ddiii
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/reconcile-core.mjs", "we:scripts/operations/operator-queue.mjs", "we:scripts/conveyor/__tests__/reconcile-core.test.mjs", "we:scripts/operations/__tests__/operator-queue.test.mjs"]
dateOpened: "2026-10-15"
tags: []
---

# Prevention — Add a branch-coverage or mutation gate on we:scripts/conveyor/reconcile-core.mjs so every conjunc… (from web-everything/web-everything#5363 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/reconcile-core.mjs:1566` — Add a branch-coverage or mutation gate on `we:scripts/conveyor/reconcile-core.mjs` so every conjunct of a new refusal-bypass condition needs a test that flips it.
2. `we:scripts/operations/operator-queue.mjs:653` — Add a queue-level test asserting each PR number appears in at most one primary section across a fixture matrix.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5363@5d2a48c15fea1f61b13018e297a713a385c8c94e

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
