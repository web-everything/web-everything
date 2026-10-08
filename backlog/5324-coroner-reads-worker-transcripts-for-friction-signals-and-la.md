---
bornAs: xc12cpi
kind: story
size: 5
status: open
scope: ["we:scripts/operations/coroner-transcripts.mjs", "we:scripts/operations/coroner-extract.mjs", "we:scripts/operations/perf-snapshot.mjs", "we:scripts/operations/__tests__/coroner-transcripts.test.mjs", "we:scripts/operations/__tests__/coroner-extract.test.mjs", "we:skills-src/coroner/SKILL.md"]
dateOpened: "2026-10-07"
tags: []
---

# Coroner reads worker transcripts for friction signals and labels outcomes truthfully (card 130 S1+S2)

The coroner extracts per-session friction (denials, EPERM, lane failures, re-runs, step timings, outcome line) from bounded transcript tails, grouped by kind x executor, and fixes outcome labels: harness-pushed fixes, per-attempt prepare failures, real build results.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
