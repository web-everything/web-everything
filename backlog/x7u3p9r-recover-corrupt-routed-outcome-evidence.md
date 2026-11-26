---
bornAs: x7u3p9r
kind: task
status: open
scope: ["we:scripts/lib/fix-slot-borrow.mjs", "we:scripts/lib/__tests__/fix-slot-borrow.test.mjs", "we:scripts/conveyor/reconcile-fix-dispatch.mjs", "we:scripts/conveyor/__tests__/reconcile-fix-dispatch.test.mjs", "we:scripts/operations/ci-heal-pr-dispatch.mjs", "we:scripts/operations/__tests__/ci-heal-pr-dispatch.test.mjs"]
dateOpened: "2026-11-26"
tags: [review-feedback]
---

# Recover corrupt routed outcome evidence without losing the refusal

PR #7532 security review found that corrupt or non-conforming per-PR routed outcome files block admission and successful-push cleanup indefinitely. The repair distinguishes this condition as `routed-outcomes-unreadable` and tells the operator to restore valid evidence; automatic recovery remains unimplemented.

## Acceptance

- Provide an explicit, bounded operator recovery path that preserves the corrupt bytes for diagnosis and restores a valid per-PR ledger from trusted evidence.
- Keep admission closed until recovery succeeds; an operator answer alone must never bypass unreadable evidence.
- Cover truncated JSON, invalid row shapes, permission errors, interrupted recovery, concurrent writers, successful-push cleanup, and isolation from other PRs.

## Test plan

Add a deterministic file-backed lifecycle test that corrupts evidence, observes the distinct refusal in both dispatchers, repairs it through the supported recovery path, and admits only after valid evidence is restored. Retain the strict corrupt-read negative tests.

## Non-goals

Do not silently discard unknown-cause records or infer operator authority from comment text.
