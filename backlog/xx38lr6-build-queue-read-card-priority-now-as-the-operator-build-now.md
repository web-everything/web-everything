---
kind: story
size: 1
status: resolved
dateResolved: "2026-10-09"
blockedBy: ["4355"]
scope: ["we:scripts/lib/build-queue.mjs", "we:scripts/lib/__tests__/build-queue.test.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# build-queue: read card priority: now as the operator build-now override (P1)

Operator rulings 2026-10-09: Plateau Build now requests carry `priority: now`, mapped to the existing verified operator override (P1). Within a class, requests precede tier and score by default; prepare-ahead preserves that classified queue order.

## Acceptance

- [A1] **Executable** — Run through the host heavy-run queue; red before / green after. Combined regression run: all 396 tests passed across build-queue, build-dispatch-policy, delivery-priority, conveyor-state and tick-core.

  ```sh
  npm run test:unit -- scripts/lib/__tests__/build-queue.test.mjs
  ```

- [A2] **Live** — In wev-control, the command below should show a card with `priority: now` at P1 ahead of aged P1 cards. Probe 2026-10-09: no such cards were present, so this live assertion remains unverified; the lane CLI against wev-control backlog and canonical sidecar also found no requests. The executable CLI sidecar fixture verifies the ordering with requests-first enabled and disabled.

  ```sh
  node scripts/backlog.mjs build-queue --json
  ```

## Design notes

Q2 amendment 2026-10-09: `requestsFirstInClass` defaults to true. Cascade: standard default → platform boolean → tool boolean → `WE_BUILD_QUEUE_REQUESTS_FIRST` ('1'/'0'); other values are ignored. The tool explicitly enables it. Enforce order is class → request (when enabled) → tier → score → legacy tail. Off and shadow retain legacy order.

## Non-goals

- [N1] n/a: the change is limited to the requested priority adapter, setting and ordering behavior.

## Edge cases this change must handle

1. **Untrusted text** — Only normalized card priority now selects the existing operator override; non-boolean settings and invalid environment values are ignored.
2. **Truncated reads** — n/a: pure ordering change, no IO besides the existing settings read.
3. **Shared state files** — n/a: no shared-state writes; existing settings and sidecar readers are unchanged.
4. **Fail closed** — Readiness and clearance gates are unchanged; off marks no row as an operator request.
5. **Identity scoping** — n/a: no identity or authorization boundary changes.
6. **State over time** — Fresh requests precede aged P1 cards when enabled; disabling restores tier/score order.
7. **Who wrote it** — Card priority now represents the operator's Build now request under the 2026-10-09 ruling.
