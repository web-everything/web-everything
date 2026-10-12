---
bornAs: xjkayvi
kind: story
size: 5
status: open
scope: ["we:scripts/conveyor/pr-status-label.mjs", "we:scripts/conveyor/review-status-tag.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# status:* is the only visible PR stage label; review-status:* becomes internal state

Refiled: 5916 (intended parent 5894, the takeover-budget card in PR #4779, not on main yet) was scaffolded 2026-10-10 in lane-20 but never reached main or a PR. Operator 2026-10-10 ~12:35 ET: PRs carry both status:fixing and review-status:fixing (and awaiting-ci, ...). Map every review-status:* value (reviewing, fixing, fixing-conflict, awaiting-ci, awaiting-base, draft-withdrawn, fix-stalled, ...) onto a status:* value in we:scripts/conveyor/pr-status-label.mjs; stop writing review-status:* labels in we:scripts/conveyor/review-status-tag.mjs (keep the value as internal state/ledger); remove old labels from open PRs through that single writer; first migrate every reader (operator-queue, /wip, coroner, drain, we:scripts/conveyor/takeover-budget.mjs#gateHoldReason) to internal state or status:*, with tests. Setting labels.legacyReviewStatus (cascade) switches the old labels back on.

## Acceptance

- [A1] **Executable** — tests: every review-status value maps to one status:* value; no code path writes a review-status:* label unless `labels.legacyReviewStatus` is on; every listed reader reads internal state or status:*.
- [A2] **Live** — after adoption, open PRs show exactly one stage label and no review-status:*.

## Non-goals

- [N1] Changing the stage model itself (only the label surface).

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: label names are fixed values.
2. **Truncated reads** — If the internal state cannot be read, keep the current label (no removal).
3. **Shared state files** — Labels written only through the single writer.
4. **Fail closed** — Unmapped value -> keep the old label and alert.
5. **Identity scoping** — Per repo and PR.
6. **State over time** — Old labels are removed once, idempotently.
7. **Who wrote it** — Only the conveyor's writer touches stage labels.

## Progress

2026-10-11: Implemented `needs-you` using the operator queue's NEEDS YOU / RULING NEEDED predicates, required-check `ci-red` with automatic readiness restoration, and reason states for escalations, stand-downs, answered stand-downs, review/red-team send-backs and waiting on a base. Legacy `review-status:*` retirement is gated by `legacyReviewStatus`; the default remains on, and the durable draft-withdrawn marker is preserved.

Remaining: migrate the `review-status:*` readers, then flip the default. The operator confirmed the regression tests red before implementation; the queued suite awaits an operator rerun after this fix.
