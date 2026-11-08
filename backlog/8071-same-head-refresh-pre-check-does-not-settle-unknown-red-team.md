---
bornAs: xvcwwbm
kind: story
size: 3
status: open
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/lib/drain-queue-safety.mjs", "we:scripts/lib/drain-merge-strategy.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# Same-head refresh pre-check does not settle unknown red-team evidence by comment, unlike the enqueue path

Flow-sim gap R3-G1, class K9 (divergent predicates for one state). Failing input: PR ready-to-merge + review:accepted, branch behind base (needs same-head merge-queue refresh), red-team result comment for head H is posted and trusted, but the run scan reports ok:false reason 'review-unfinished' or scan-capped (the exact cases settleUnknownEvidenceByComment exists for).' 'drain tries the mq same-head refresh … Cited: we:scripts/merge-ai-prs.mjs:4835-4852, we:scripts/lib/drain-queue-safety.mjs:463-471, we:scripts/lib/drain-merge-strategy.mjs:365. Soak-break sketch: stuck: refresh returns false (allow: enqueueAllowed()===true, we:drain-queue-safety.mjs:157) every pass, so the behind-branch PR is never refreshed/enqueued even though the enqueue path itself would admit it; no timer or settler on this path.

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
