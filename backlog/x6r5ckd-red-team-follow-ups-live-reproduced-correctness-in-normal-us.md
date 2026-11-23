---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/resource-pool-io.mjs", "we:scripts/lib/resource-pool-lanes.mjs"]
dateOpened: "2026-11-23"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use, theoretical-race] from web-everything/web-everything#7353 (head 120afb84f)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7353 (reviewed head `120afb84fb8ea58155f9793b9b879f1eb5235a2f`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/resource-pool-io.mjs:211` — (edge-case, degraded) Expired heavy-slot records count as live fix workers
   - Scenario: A crashed fixer leaves a heavy-slot record with heartbeatAt 2026-11-20T00:00:00.000Z and meta.dispatchKind='fix'. At 2026-11-23T12:00:00Z, with no lane lease, the workers reader still returns ok=true and charges 2 C3 units. Three distinct leftovers exhaust the default C3 maximum, producing false shadow holds. Confirmed expired/dead records should be excluded; uncertain liveness should remain unknown.
   - Class: live-reproduced (basis: Executed the unchanged worker-reader function in an in-memory module harness with injected lane/heavy inventories. The expired record produced a known 2-unit holder; the existing reclaim rule considered it reclaimable. No live-host failure is claimed.)
   - Also class: correctness-in-normal-use
   - Claude's re-check: demonstrated break
2. `we:scripts/lib/resource-pool-lanes.mjs:40` — (edge-case, degraded) Sibling-repository fix workers disappear from the inventory
   - Scenario: Run from a web-everything lane while its pool is empty and frontierui/lane-1 has a valid live conveyor-fix lease. Once its dispatch claim expires, and with no heavy command running, the sibling fixer disappears: the adapter scans only the web-everything pool and returns no lanes. The studio ledger should include sibling-pool workers or identify that evidence as unknown.
   - Class: live-reproduced (basis: An in-memory filesystem probe executed the actual lane adapter with both repository pools present. The sibling lease passed poolLaneLeased, but only the web-everything directory was inspected and the adapter returned an empty inventory.)
   - Also class: correctness-in-normal-use
   - Claude's re-check: demonstrated break
3. `we:scripts/lib/resource-pool-io.mjs:86` — (edge-case, degraded) Reducing capacity hides occupied slots beyond the new scan bound
   - Scenario: Acquire slot-6 when the slot span is at least seven, then reduce cap plus fastSlots to six while that fixer remains active. With no remaining lane/claim evidence, readPoolHeavyHeld scans only slots 0–5 and reports an empty inventory despite the occupied slot-6. Existing occupied slots must remain inventoried after capacity changes.
   - Class: live-reproduced (basis: Executed readPoolHeavyHeld against an in-memory filesystem containing occupied slot-6 with cap=6. It inspected six lower slots, never inspected the occupied directory, and returned held=[]. This is a deterministic sequential configuration-change case.)
   - Also class: theoretical-race
   - Claude's re-check: demonstrated break

## Acceptance

- [A1] **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] TODO: what this item deliberately does not do — or `n/a: <why>` when nothing is excluded.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
