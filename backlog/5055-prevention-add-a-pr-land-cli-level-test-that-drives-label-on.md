---
bornAs: xq81xk3
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/pr-land.mjs", "we:scripts/conveyor/__tests__/main-red-recovery.test.mjs", "we:scripts/conveyor/reconcile-core.mjs", "we:scripts/conveyor/__tests__/reconcile-pass.test.mjs", "we:scripts/__tests__/pr-land.test.mjs", "we:scripts/conveyor/__tests__/reconcile-core.test.mjs"]
dateOpened: "2026-10-04"
tags: []
---

# Prevention — Add a pr-land CLI-level test that drives --label-on-green to a check-red exit with a fake forge a… (from web-everything/web-everything#3887 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/pr-land.mjs:699` — Add a pr-land CLI-level test that drives `--label-on-green` to a check-red exit with a fake forge and asserts `addLabel('review:pending')`. Alternatively, file a backlog item for a standards rule against bare `catch {}` around calls whose failure changes behaviour.
2. `we:scripts/conveyor/__tests__/main-red-recovery.test.mjs:873` — Doc note only: keep 'RED before the fix' for tests that were actually run against the unfixed code.
3. `we:scripts/conveyor/reconcile-core.mjs:1700` — Pass `requiredChecks` (declared fallback) into the restore branch, or require `requiredChecks` to be non-empty before dispatching. Add a regression test that red declared-required check + default classifier ⇒ no restore-review-label.
4. `we:scripts/conveyor/reconcile-core.mjs:1371` — Add a unit test pinning the no-timestamp behaviour, and make the helper fail closed (wait) or document why it is open.
5. `we:scripts/conveyor/reconcile-core.mjs:1373` — Add a deterministic planner regression asserting that missing or invalid timestamps require another trustworthy age signal before restoration.
6. `we:scripts/conveyor/__tests__/reconcile-pass.test.mjs:1192` — Extend the named test to set the environment variable to '0', omit enabled, and assert that neither evidence nor budget readers execute, restoring the environment afterward.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#3887@829d8ce71c6d25c6df82fc259179633aeb51373e

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
