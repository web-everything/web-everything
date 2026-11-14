---
bornAs: xjdn3sd
kind: story
size: 5
status: open
scope: ["we:scripts/merge-ai-prs.mjs"]
dateOpened: "2026-11-14"
tags: []
---

# Cut drain pass time: profile and parallelise the cascade, gate reads and listing

Drain pass takes about 26 min under load (listing 292s, context 275s, mergeCascade 860s, postMergeSync 234s; 2026-11-13 21:10 ET), so ready PRs wait one pass each. Profiled medians in we:scripts/merge-ai-prs.mjs: cascade 46s (mean 175s; slow passes are refresh+merge under the land lock, lines 7442-7450), classifyGateReads 29s (lines 5814-5866, concurrency 6), listing 21s (seed spikes 9-14s). Smallest wins: (1) cascade: skip PRs whose skip reason cannot change (sent-back, mq-same-head-failed, ready-not-reached); run mergeQueueGate precheck and refreshApprovedHead in a bounded pool (3-4) outside the land lock, keep only mergePr serial (about 30-50%); cap refreshes at 1-2 per pass. (2) gateReads concurrency 6 to 10-12 behind gh-throttle, skip held and unchanged heads (about 10-15s). (3) list pages and checks across repos in parallel and persist the seed (about 10-20s). Split into 3 small PRs. Pairs with merge-queue stories 2/3 and card 5736.

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
