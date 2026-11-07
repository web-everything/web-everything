---
kind: story
size: 5
status: open
scope: ["we:scripts/conveyor/pr-status-label.mjs", "we:scripts/progress-board.mjs", "we:scripts/lib/review-escalation.mjs", "we:scripts/merge-ai-prs.mjs", "we:scripts/lib/drain-merge-strategy.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# review:accepted + review:changes pair read three different ways

Flow-sim gap D-C4, class K9 (divergent predicates for one state). Failing input: labels [ready-to-merge, review:accepted, review:changes], head H = accepted head, CI green. Producible by a human adding review:changes in the UI, a pre-#2974 leftover, or accept-carry-forward moving an accept to a new head (it recognises a later changes verdict only from comment shapes, we:accept-carry-forward.mjs:101-134, not… Cited: we:scripts/conveyor/pr-status-label.mjs:141, we:scripts/progress-board.mjs:559, we:scripts/lib/review-escalation.mjs:2531, we:scripts/merge-ai-prs.mjs:1101, we:scripts/lib/review-escalation.mjs:3073-3222. Soak-break sketch: none (approved-human-head-review-churn touches revalidateForMerge only)

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
