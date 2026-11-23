---
bornAs: xjf40jo
kind: story
size: 8
priority: low
parent: "2531"
status: parked
parkedReason: maturityGated
maturityTrigger: "adoptionSignal: Phase 2; multi-user approval and roles."
dateParked: "2026-11-22"
scope: ["plateau:src/backlog-view/", "we:scripts/lib/build-queue.mjs", "we:scripts/backlog.mjs", "plateau:src/build-runner/"]
dateOpened: "2026-07-28"
tags: []
---

# Build-control: multi-user approval, roles and circuit-breakers

Generalize the single-operator buildQueued clear (plateau:src/backlog-view/write-action.ts build-queue add/remove + we:scripts/lib/build-queue.mjs nextToBuild gate) into a permissioned multi-user build gate: owner/admin/member roles, an approval step, and delegation. Extends the single kill-switch (runner stop) into global + per-tenant kill-switches, rate/quota limits and runaway auto-pause (quota-stall). Roles and approval are greenfield; independent of cost-metering.

Parked 2026-11-22 (plateau ruling, master plan). Unpark when: Phase 2; multi-user approval and roles.
