---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/reconcile-core.mjs", "we:scripts/conveyor/__tests__/reconcile-advisory-head-move.test.mjs", "we:scripts/conveyor/__tests__/reconcile-core.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — Add a table-driven planner test that runs every repair owner (stale-base, stacked-rebase, conflic… (from web-everything/web-everything#7263 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/reconcile-core.mjs:3708` — Add a table-driven planner test that runs every repair owner (stale-base, stacked-rebase, conflict) against each new early-`continue` refusal, with the feature setting both on and off. A lint that flags a new unconditional `continue` ahead of existing owners in `planReconcile` would be a stronger gate.
2. `we:scripts/conveyor/reconcile-core.mjs:1647` — Add a backlog card to pin the accepted trailer names to an allowlist of known `Conveyor-*` keys, or to verify the commit author is the conveyor identity. Back it with a negative test for a foreign trailer name. A lint or check:standards rule for 'author-controlled commit text used as a trust signal' would cover the class.
3. `we:scripts/conveyor/__tests__/reconcile-advisory-head-move.test.mjs:135` — Add a deterministic integration test that executes the advisory outcome and asserts that review:human remains and no accepting verdict is published.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7263@d0c1e96b2c112a4dfb2ddc33548bb1ef062cff24

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
