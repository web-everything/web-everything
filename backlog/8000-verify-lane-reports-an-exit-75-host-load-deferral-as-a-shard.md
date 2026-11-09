---
bornAs: x8oo9hx
kind: story
size: 3
status: resolved
dateOpened: "2026-11-04"
dateResolved: "2026-11-07"
graduatedTo: b155a88804d349b7ae6729e0cb2bb20bbc315a5f
tags: []
---

# verify-lane reports an exit-75 host-load or memory-pressure deferral as a shard INVENTORY-INCOMPLETE (capacity/wait) and fires at once instead of queueing

A verify run that heavy-admission defers for host load or host memory pressure (vitest exit 75; load over host.maxLoadPerCore, or reclaimable headroom under host.minMemoryHeadroomMb) is labelled 'a test shard stayed INVENTORY-INCOMPLETE after one split retry (capacity/wait)' and returns infrastructure-failure within 2-7s, even with --wait=540000. Expected: a truthful 'deferred for host load' label and a queued wait that honours --wait. Evidence: lane-22 verify attempts at load 76-79.

## Acceptance

- [A1] **Executable** — `npm run test:unit -- we:scripts/lib/__tests__/verify-shard-run.test.mjs` (describe 'local shard wait budget') fails before and passes after: a shard that must run locally gets `--wait-ms=<verify.localShardWaitMs>` (default 15 min, env WE_VERIFY_LOCAL_SHARD_WAIT_MS), and a shard still without a slot exits 75.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] Does not change the global heavyAdmission.runWaitMs default, the load gate, the caps or the exit-75 contract. The we:scripts/lib/lane-verify.mjs INVENTORY-INCOMPLETE wording is left to a follow-up (file out of this item's scope); verify-shard-run itself now logs 'host-load deferral (waited up to Ns)'.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: the only new input is a whole-number env value.
2. **Truncated reads** — n/a: no reads added.
3. **Shared state files** — n/a: no state files written.
4. **Fail closed** — a non-numeric or out-of-range env value falls back to the 15 min standard; no slot within the budget still exits 75 (never green).
5. **Identity scoping** — n/a: per-process.
6. **State over time** — the wait is capped by the remaining verify budget.
7. **Who wrote it** — n/a: no markers.

## Progress

- 2026-11-05: `verify.localShardWaitMs` added in `we:scripts/lib/verify-shard-run.mjs` (cascade: standard 15 min, platform `verify`, env `WE_VERIFY_LOCAL_SHARD_WAIT_MS`). Shards naming a git-spawning test now pass a bounded `--wait-ms` to heavy-admission. Remaining: reword we:scripts/lib/lane-verify.mjs, line 351 (out of scope here).
