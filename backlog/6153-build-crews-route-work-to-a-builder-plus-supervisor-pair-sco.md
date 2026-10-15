---
bornAs: x1klrd9
kind: decision
status: open
scope: ["we:scripts/lib/provider-routing.mjs", "we:scripts/lib/dispatch-routing-policy.json", "we:scripts/settings/"]
dateOpened: "2026-10-15"
tags: []
---

# Build crews: route work to a builder plus supervisor pair, scored per crew

Operator idea 2026-10-15: make supervised builds a product concept. A crew = {builder, supervisor, mode} (modes: check-before-push, pair, review), declared as a cascade setting build.crews; routing picks a crew by task kind and risk (CRITICAL_WORK_GATE still forces Claude); scorecards per crew (success, rounds, red-team misses, cost) drive promotion and demotion. Folds in we:scripts/lib/provider-routing.mjs PROBATION_WORKERS.checker, the fixer fallback chain (PR #5332) and Argon builds (PR #5370). Examples: codex/gpt-6-astra built + gpt-6.1-sol supervised; agy/gemini-4-argon-high + gpt-6.1-sol. Decide: crew schema, mode semantics, scorecard unit, migration from per-model probation, and how crew choice interacts with subscription budgets.

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
