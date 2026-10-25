---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-10-25"
tags: []
---

# Model value analysis as a recurring product operation

[held entry 286] (operator 2026-10-13 ~20:45 ET, held — after the first manual analysis lands) Model value analysis as a recurring product operation: run regularly (cadence = setting) with history (ops-branch ledger, append-only, like the verdict ledger), cited sources (price table in settings with source URL + retrieved date + effective-until/intro-end), and options (settings). Inputs: price sources, usage ledgers (codex-direct-task usage, Claude wrapper/subagent tokens, agy trial report), quality signals (fix success/unproductive, confirmed findings, red-team misses, prepare outcomes). Output: report + PROPOSED routing-setting diffs (codex.modelByTask / routing policy / taskTier card 263) — never auto-applied; alerts before intro prices expire. Respects review invariants (card 285 rules).

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
