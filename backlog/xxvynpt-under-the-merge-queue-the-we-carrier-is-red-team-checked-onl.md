---
kind: story
size: 5
status: open
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/lib/drain-merge-strategy.mjs", "we:scripts/lib/drain-skip-reasons.mjs", "we:scripts/lib/enqueue-on-event.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# Under the merge queue the WE carrier is red-team-checked only AFTER its impl half has merged, and a carrier t…

Flow-sim gap R7a-G1, class K9 (divergent predicates for one state). Failing input: Strategy github-merge-queue (we:drain-merge-strategy.mjs:300: enqueues(repo) is true only for the local WE repo). plateau-app#1 (impl, direct merge) and we#3 (carrier) both ready-to-merge + review:accepted, test green. waitForRedTeamBeforeEnqueue is true (we:drain-queue-safety.mjs:431 standard), so the post-accept red team has … Cited: we:scripts/merge-ai-prs.mjs:7065, we:scripts/merge-ai-prs.mjs:1133-1147, we:scripts/merge-ai-prs.mjs, we:scripts/merge-ai-prs.mjs:6866-6868, we:scripts/merge-ai-prs.mjs:7284-7290. Soak-break sketch: Fixture: couple-split-by-unrelated-merge seedCouple with policy mergeStrategy=github-merge-queue for we and a pending red-team (no result comment, scheduled) on the carrier head. Action: one drain pass. Assertion that fails today: plateau-app impl MERGED, we …

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
