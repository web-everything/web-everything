---
kind: task
status: open
dateOpened: "2026-11-23"
tags: [conveyor, testing]
scope: ["we:scripts/conveyor/owed-fix-recovery.mjs", "we:scripts/conveyor/reconcile-fix-dispatch.mjs", "we:scripts/operations/ci-heal-pr-dispatch.mjs", "we:docs/agent/testing.md"]
---

# Audit the seven owed-fix recovery hardening waivers

PR #7336's body claims seven R1085 hardening findings were waived and carded, but the supplied record names no original card ids. The local backlog search did not locate cards matching that list. This is a new traceable follow-up, not evidence that the historical cards existed or that the waivers were independently validated. Assignment to a responsible maintainer remains pending.

## Acceptance and named planned checks

| Reported waiver | Planned check and required observation |
| --- | --- |
| Wrapper wiring bypass | `owed-fix-wrapper-defaults`: both daemon cache and routed CI-heal wrappers enable recovery with omitted options; missing/evicted tokens explicitly retain ordinary planning. |
| Fixing-claim TTL | `owed-fix-fixing-lease`: retain a fixing claim for its production lease and grace period; prove no premature release using the production writer. |
| Unreadable verification evidence | `owed-fix-verify-unknown`: unreadable or partial awaiting-verification evidence must refuse release with a visible reason. |
| Snapshot freshness | `owed-fix-stale-session-snapshot`: a stale session inventory cannot authorize recovery even when a fresh PR-head read succeeds. |
| Fail-open PID probe | `owed-fix-runner-pid-absent`: explicitly decide and document the absent-runner-PID policy; test absent, alive, dead and unknown results, retaining live/unknown holders. |
| Needs-you feed clearing | `owed-fix-feed-retains-unresolved`: a polling pass lacking the recovery condition cannot erase an unresolved recovery escalation. |
| Writer before capability admission | `owed-fix-unsupported-consumer-no-writes`: unsupported capability admission leaves recovery state and claims unchanged. |

Before closing, link the original waiver/ruling and existing card for each row if found, otherwise retain this card as the accountable follow-up. Record implementation or explicit disposition and named observable results for all seven. Do not characterize every risk as fail-closed without that evidence.

## Prevention

The waiver-to-backlog-id check is tracked by `xo73mt1` (`waiver-card-id-missing-rejected`). A waiver without a resolvable card id and assigned owner must remain unverified.
