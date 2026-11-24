---
name: stale-state
description: Inventory claims, lane leases and operation run records before concluding the lane pool is full or a lane is abandoned. Read-only liveness evidence; never releases or cleans up state.
---

# Inspect stale state before cleanup

## Run the inventory

Before concluding the lane pool is full or a lane is abandoned, run:

```bash
node scripts/operations/run.mjs stale-state --json
```

Read `verdict.records` and `verdict.gaps`. Each record carries observed PID evidence, age in
milliseconds, `live` / `dead` / `unknown`, and best-effort `hasUnsafeWork` (`null` means unknown).
The scope and evidence limits are described in
[the testing guide](../../docs/agent/testing.d/045-web-cases-protocol-conformance-fixtures.md#stale-state-inventory).

## The null-PID trap

A null PID is not proof of death; it is absence of evidence. A lease's recorded PID belongs to
the acquire command, so even observing it dead does not establish that the owner is dead.
Do not treat TTL expiry, a finished run, or a clean lane as proof of owner death.

## Cleanup is a separate action

Use today's manual process through the supported lane-release and backlog lifecycle commands,
as documented in [the backlog workflow](../../docs/agent/backlog-workflow.md), after inspecting
ownership and preserving unsafe work. A future `reap-stale-state` operation may consume this
report; it does not exist here. Never hand-edit lease or claim files directly.
