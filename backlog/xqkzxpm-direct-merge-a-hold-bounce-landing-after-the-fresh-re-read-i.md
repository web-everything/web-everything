---
kind: story
size: 2
status: open
scope: ["we:scripts/merge-ai-prs.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# Direct merge: a hold/bounce landing after the fresh re-read is not seen (labels not re-read before mergePr)

Flow-sim gap D-C2, class K6 (check-then-act race with no pin). Failing input: non-local repo; labels [ready-to-merge, review:accepted]; head H; reviewer bounces: review-set-label --to=changes atomically strips accepted + ready-to-merge and adds review:changes (we:review-set-label.mjs:728-740).' 'bounce lands after MAP:7168 revalidateForMerge read but before MAP:7287 gh pr merge. Window contains mergeQueu… Cited: we:scripts/merge-ai-prs.mjs:7168-7204, we:scripts/merge-ai-prs.mjs:7279-7287, we:scripts/merge-ai-prs.mjs:5110. Soak-break sketch: none

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
