---
kind: story
size: 3
status: open
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/lib/human-clearance-carry.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# Carry record posted without a live re-read for strict/contribution tiers

Flow-sim gap C-G7, class K6 (check-then-act race with no pin). Failing input: Operator cleared head A (clear-human comment is the latest accept-shaped one); drain merged main in to produce head B with identical net diff; evidence snapshot read at T0. Operator posts a send-back ('🔁 review — changes requested') or a review:human hold at T1 > T0.' 'E23 / E8 concurrent send-back during the carry Cited: we:scripts/merge-ai-prs.mjs:917-920, we:scripts/lib/human-clearance-carry.mjs:380-384. Soak-break sketch: approved-human-head-review-churn (carry of approved human-surface heads; fixPresent true: we:merge-ai-prs.mjs contains readApprovedHumanSurfaceHold and we:review-job.mjs contains decideRebaseVerdictCarry). Race with a send-back not covered.

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
