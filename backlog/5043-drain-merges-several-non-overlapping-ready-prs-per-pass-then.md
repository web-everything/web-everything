---
bornAs: x25an7c
kind: story
size: 5
parent: "3383"
status: open
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/readiness/overlap-chain.mjs"]
dateOpened: "2026-10-03"
tags: []
---

# Drain merges several non-overlapping ready PRs per pass, then numbers and syncs once

Operator ruling 2026-10-03. Measured that evening: each drain pass takes 90-140 s and merges exactly one PR (listing ~22 s, check reads 13-21 s, merge cascade 8-26 s, JIT numbering 20-37 s, merge call 3-9 s), with 9-11 ready candidates waiting, so ready PRs queue for 20+ min. Change we:scripts/merge-ai-prs.mjs so one pass merges up to N ready PRs whose touch-sets do not overlap (reuse the overlap matching in we:scripts/readiness/overlap-chain.mjs), each still passing its own gate reads, then runs JIT numbering, push and derived regen once for the batch. Overlapping PRs stay one per pass in order. N is a configurable setting (default 5) per config-extends-platform-default. A merge refused mid-batch stops the batch cleanly. Done when: tests cover batch selection, overlap exclusion, mid-batch refusal and single numbering; live: a pass with several ready disjoint PRs merges more than one, with before/after merges-per-hour.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
