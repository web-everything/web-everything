---
kind: story
size: 3
status: open
dateOpened: "2026-11-25"
scope: ["we:scripts/review-set-label.mjs", "we:scripts/conveyor/__tests__/"]
tags: [prevention]
---

# Inventory callers when shared writer flag semantics change

PR #7480 extended head pinning into a red-team refusal and blocked the orphan guard's real-code recovery. The repair adds an explicit no-code opt-in and exercises the orphan guard's actual argv for both red-team labels. Extend this protection to all callers of shared writer flags.

## Acceptance

- A deterministic caller inventory names the production argv producers for each shared writer flag whose behavior changes; a newly discovered caller without a contract fails the test.
- Exercise ordinary fix, orphan recovery, CI-heal missing-label recovery, conflict recovery and no-code execution. Pin existing behavior for each argv shape, including unknown labels and head changes.
- Changing only the no-code security policy must not change ordinary pinned re-arm behavior.

## Origin

PR #7480 review, 2026-11-25: correctness/correctness finding 1 and security/delivery-stability finding 1. The immediate regression test lives in `we:scripts/conveyor/__tests__/no-code-rearm.test.mjs` (`orphan guard argv still rearms a repaired PR carrying %s`).
