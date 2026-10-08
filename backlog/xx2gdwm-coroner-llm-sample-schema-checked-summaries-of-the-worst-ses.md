---
kind: story
size: 5
status: open
scope: ["we:scripts/operations/coroner-sample.mjs", "we:scripts/operations/__tests__/coroner-sample.test.mjs", "we:skills-src/coroner/SKILL.md"]
dateOpened: "2026-10-08"
tags: []
---

# Coroner LLM sample: schema-checked summaries of the worst sessions, with a stability-stepped sample size (card 130 S3)

Card 130 S3. Each coroner run picks the worst N sessions by minutes lost (S1 signals), has a cheap model summarise each friction into a worker-result-shaped record (outcome, blocker.kind, evidence, proposedFix), validates and drops invalid ones with a count. Knob coroner.sampleSize defaults 25-30; when the top-5 friction ranking is unchanged for 3 runs, N halves (floor 5); a change resets to large. Ranking persisted beside the perf snapshots; cost per run reported. Code: we:scripts/operations/coroner-sample.mjs.

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
