---
bornAs: x8m4q2v
kind: task
status: open
scope: ["we:scripts/lib/__tests__/fix-slot-borrow.test.mjs", "we:scripts/conveyor/__tests__/reconcile-fix-dispatch.test.mjs", "we:scripts/operations/__tests__/ci-heal-pr-dispatch.test.mjs"]
dateOpened: "2026-11-26"
tags: [review-feedback]
---

# Pin admission for legacy routed outcomes without a cause

PR #7532 simplicity advisory identified a missing named admission regression for the deliberate exemption of historical rows without a `cause` property from the new unknown-cause recovery guard. File this coverage separately from the current repair, as the review requested.

## Acceptance

- Exercise both dispatchers with persisted historical failed rows lacking `cause`; prove that the unknown-cause guard alone does not hold them.
- Keep separate negative cases for explicit `cause: unknown`, invalid causes, unreadable files, and existing unanswered parks.
- Preserve model counting of historical no-change outcomes and independent raw session ceilings.

## Test plan

Use a shared cause-property matrix through real dispatcher admission. Assert launch counts and precise refusal kinds; removing the historical exemption must fail its named positive case.

## Non-goals

Do not widen the exemption to newly written or malformed evidence.
