---
kind: decision
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-10-25"
tags: []
---

# Risk-scaled review panel with two hard invariants

[held entry 285] (operator 2026-10-13 ~20:45 ET, held — WAIT for more data: Argon trial 30+ reviews and a misses-after-accept measure) Risk-scaled review panel with two hard invariants — FILE AS A DECISION, NOT A BUILD (operator ~20:50 ET: "we will want the suggestion reviewed after a good research on best practices"): first a research pass (multi-model / LLM-as-judge review ensembles, reviewer diversity vs correlated errors, risk-based review depth, published code-review studies), then a prepared decision reviewed by the jury, then the operator rules; only then slice and build. (1) always >=1 Claude review; (2) always >=1 review from a model family different from the builder of the PR; beyond that, seat count scales with criticality (low 2 / elevated 3 / high full panel + red team) and extra seats are filled per lens by measured performance (confirmed findings, misses-after-accept, cost) — "we should not run all the models all the time depending on risk as we add more models". Invariants are refusals, not warnings; all knobs settings. Builds on careLevel, cards 263/264. Also add misses-after-accept to the agy shadow trial report.

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
