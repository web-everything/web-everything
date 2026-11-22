---
kind: task
status: open
dateOpened: "2026-11-22"
tags: [conveyor, testing]
scope: ["we:scripts/conveyor/owed-fix-recovery.mjs", "we:scripts/conveyor/__tests__/reconcile-fix-dispatch.test.mjs"]
---

# Test owed-fix ledger rollback with competing writers

PR #7336's simplicity and codex-correctness advisory findings both request a named test for the ledger's compare-and-swap promise. Existing capacity tests restore an unchanged reservation but do not establish preservation of another pass's intervening state.

## Acceptance

- Admit a recovery, persist a second pass's update, then settle the first pass without a launch; assert the second pass's state survives unchanged.
- Exercise the shared transaction lock with real temporary files and competing processes; only one reservation may release/dispatch for the same repo, PR, head and kind.
- Verify an unchanged reservation is restored, an attempted launch is retained, and a stale holder cannot roll back newer state.

## Proof plan

Use deterministic synchronization rather than sleeps. Report the named tests and a mutation that removes the compare-and-swap check and fails the intervening-write assertion.
