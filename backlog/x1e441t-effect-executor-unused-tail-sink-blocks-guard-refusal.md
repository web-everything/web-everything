---
kind: task
status: open
scope: ["we:scripts/operations/effect-executor.mjs", "we:scripts/operations/effect-executor.test.mjs"]
dateOpened: "2026-11-13"
tags: []
related: ["6584"]
---

# Effect executor: unused tail sink can block persisted guard refusal from finalizing

we:scripts/operations/effect-executor.mjs:253 — an unused tail sink can keep a persisted guard refusal pending (main behaves the same; fail-safe, not a regression, R903). Red-first test: effect-executor finalizes a persisted guard refusal even when a tail sink is unused.

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

## Duplicate admission

red-team break carded under R903/R907/R918

new break found in #6584 red-team
