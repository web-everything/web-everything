---
kind: task
status: open
dateOpened: "2026-11-23"
tags: [conveyor, testing]
scope: ["we:scripts/conveyor/owed-fix-recovery.mjs", "we:scripts/conveyor/__tests__/reconcile-fix-dispatch.test.mjs"]
---

# Reconcile owed-fix reservations with completed same-head sessions

PR #7336's security availability finding identifies an ordinary planner re-offer after an unproductive completed fixer: recovery state suppresses it for 30 minutes, then indefinitely after escalation on that head and kind. The existing first-attempt suppression test establishes listing-lag protection, not the completed-session case. Assignment to a responsible maintainer remains pending.

## Acceptance and named planned checks

- `owed-fix-completed-session-reoffer`: observe an initial launch, a completed session with no push, then a legitimate planner re-offer at +10 minutes on the same head; distinguish observed completion from missing/listing-lag evidence.
- `owed-fix-escalated-reoffer`: after the retry and one escalation, offer the same head/kind again following a completed session; demonstrate the chosen bounded recovery or explicit operator-reset policy.
- `owed-fix-sidecar-expiry`: implement a documented TTL/cleanup or explicit episode-reset rule without enabling an unlimited same-head redispatch loop; test before/at/after the boundary, active reservations, unreadable evidence and competing writers.
- Preserve one-time needs-you publication and update append within an episode. Pin a no-completion positive control that retains the current listing-lag suppression.

## Proof plan

Record later-tick dispatch counts, persisted state and escalation counts for each fixture. The separate park fix preserves ordinary draft rows with no recovery episode; it does not resolve this recorded-episode availability question.
