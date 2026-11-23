---
bornAs: xgko7dt
kind: story
size: 5
priority: low
parent: "2531"
status: parked
parkedReason: maturityGated
maturityTrigger: "adoptionSignal: Phase 2; per-tenant budget gate."
dateParked: "2026-11-22"
blockedBy: ["2779"]
scope: ["plateau:src/build-runner/build-action.ts"]
dateOpened: "2026-07-28"
tags: []
---

# Per-tenant budget-gate: refuse a build that would exceed remaining quota

Enforce spend + build-count quotas per tenant before a build starts: a build that would exceed the tenant remaining budget is refused, not started. The enforcement point is pre-spawn in plateau:src/build-runner/build-action.ts, alongside the existing WIP=1 slot claim and pre-spawn abort checks, before runner.spawn. Greenfield: no per-tenant concept exists to hang a budget on yet, so it blockedBy the cost-metering slice that introduces the trustworthy per-tenant metered spend record.

Parked 2026-11-22 (plateau ruling, master plan). Unpark when: Phase 2; per-tenant budget gate.
