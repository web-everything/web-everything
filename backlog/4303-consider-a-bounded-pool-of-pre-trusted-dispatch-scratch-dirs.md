---
bornAs: xmizuz1
kind: task
parent: "4075"
status: open

dateOpened: "2026-09-27"
tags: []
---

# Consider a bounded pool of pre-trusted dispatch scratch dirs instead of one fresh dir per dispatch

#4174 follow-up (fixed via we:scripts/operations/dispatch-lane-io.mjs's defaultSpawnAgent verify/re-grant/retry-once + isTrustRefusal reclassification + the new dispatch-trust-refused health smell) closed the lost-update race for the common case, but the root architectural cause remains: every dispatch mints a brand-new, never-reused scratch cwd (we:scripts/operations/dispatch-lane-io.mjs#dispatchSessionCwd), so trust can never be granted once ahead of time the way the lane pool is (we:scripts/bootstrap-session.mjs pre-trusts the lane pool once at bootstrap). If the dispatch-trust-refused health smell ever fires again after this fix lands, consider dispatching under a small, bounded, REUSED pool of pre-trusted scratch dirs instead of a fresh directory every time.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

## Findings (standalone worker, 2026-10-12)

The build-dispatch daemon held #4303 with:

> worker-declined: **could-not-prepare** — #4303 leaves a policy choice unresolved: retain per-session directories with trust retries, or adopt a bounded reusable pool, including what dispatch does when every slot is occupied. Current code confirms: - Per-session allocation remains in 'we:scripts/operations/dispatch-lane-io.mjs:2144'. - Trust refusal gets one retry in 'we:scripts/operations/dispatch-lane-io.mjs:1955'. - Cleanup deletes directories and revokes trust in 'we:scripts/conveyor/session-reaper.mjs:1929', so pooling requires coordinated lifecycle changes. I found no subsequent recorded decision settling t…

`scope:` was cleared above so this card is picked up by the existing unshaped-item auto-prepare path;
a prepare pass re-scopes it against the finding.
