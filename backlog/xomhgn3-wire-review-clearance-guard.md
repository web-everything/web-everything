---
kind: story
size: 3
status: open
scope: ["we:scripts/lib/merge-gate-hold-class.mjs", "we:scripts/conveyor/reconcile-pass.mjs", "we:scripts/conveyor/ci-red-recovery-watch.mjs", "we:scripts/review-set-label.mjs", "we:scripts/operations/fix-run.mjs"]
dateOpened: "2026-10-13"
tags: []
---

# Wire the review-clearance guard into the held reconcile, CI-red watch and clearance paths

Live #5193 (2026-10-13): a stale review-hold merge-gate failure read as red CI and a ci-heal replayed a no-push re-arm that removed the operator's clear-human acceptance. The approval-rearm-guard PR added we:scripts/lib/review-clearance-guard.mjs (settings block reviewClearance) and wired it only into free files (we:scripts/conveyor/rearm-review.mjs CLI, we:scripts/operations/ci-heal-pr-dispatch.mjs). Wire it where those files were held by open PRs: (1) we:scripts/lib/merge-gate-hold-class.mjs excuseMergeGateRows and we:scripts/conveyor/reconcile-pass.mjs: classify a review-hold-only merge-gate failure via classifyGateFailure as not red CI even for a ready-to-merge candidate (mark it pending, re-run owed), so reconcile never plans the ci-heal (held by #5235); (2) we:scripts/conveyor/ci-red-recovery-watch.mjs sweepCiRedRecovery: drop review-hold-only merge-gate and review-gate rows before buildCandidates so the watch stops logging own-failure owed a ci-heal (held by #5152); (3) we:scripts/review-set-label.mjs accepted/clear-human: request the stale merge-gate job re-run right after the clearance via decideStaleGateRerun (held by #5223); (4) we:scripts/operations/fix-run.mjs pending re-arm replay: settle the pending record when rearm-review reports refused same-head-clearance, and when the earlier re-arm was refused for having nothing to re-arm (held by #5185). Each red-green with the #5193 fixture in we:scripts/lib/__tests__/review-clearance-guard.test.mjs.

## Acceptance

- [A1] **Executable** — TODO: a command that fails before this item lands and passes after.
- [A2] **Approval trust review** — For each trust predicate on an automatic approval-granting path, require a named negative test in the review test plan. Cover forged marker authors, non-automation removal actors (including the operator), missing evidence, time-window violations, and intervening holds by both the removal actor and another actor. A duplicate hold in the same timestamp must also block restoration; only one original automated swap event is exempt. PR #5237 pins these negatives in `review-clearance-guard.test.mjs`; preserve them when wiring the held paths. This checklist is the review requirement until a predicate-to-test lint exists.

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
