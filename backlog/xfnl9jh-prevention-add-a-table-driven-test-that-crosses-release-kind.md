---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/red-team-gate.mjs", "we:scripts/operations/record-red-team-ruling-io.mjs", "we:scripts/lib/__tests__/red-team-gate.test.mjs", "we:scripts/operations/__tests__/record-red-team-ruling-io.test.mjs"]
dateOpened: "2026-10-26"
tags: []
---

# Prevention — Add a table-driven test that crosses release kind (not-real, card, clear-human) with order (befor… (from web-everything/web-everything#5923 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/red-team-gate.mjs:687` — Add a table-driven test that crosses release kind (not-real, card, clear-human) with order (before or after the block) and asserts held in all cells. Also run a mutation check on each clause of the held predicate.
2. `we:scripts/operations/record-red-team-ruling-io.mjs:367` — Add a shared helper for deterministic ledger ids with a read-back check and use it in both sinks. Add a test that retries after a failed release POST and asserts the ledger row count stays at one.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5923@ddd5dda965b31fd1fc01c9ed32a7e77f69babe44

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
