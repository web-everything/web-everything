---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lane-pool.mjs", "we:scripts/verify-lane.mjs", "we:scripts/lib/lane-lease-liveness.mjs", "we:scripts/__tests__/lane-pool.test.mjs", "we:scripts/__tests__/verify-lane.test.mjs", "we:scripts/lib/__tests__/lane-lease-liveness.test.mjs"]
dateOpened: "2026-11-20"
tags: []
---

# Prevention — Add a test whose LANE_POOL_ROOT is a symlink to the real pool, and compare realpaths in pool-memb… (from web-everything/web-everything#7179 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lane-pool.mjs:397` — Add a test whose LANE_POOL_ROOT is a symlink to the real pool, and compare realpaths in pool-membership checks. Filing this as a lint rule is not worth it.
2. `we:scripts/lane-pool.mjs:2368` — Retry the guarded removal a bounded number of times, and add a test that holds the guard during a refused acquire.
3. `we:scripts/lane-pool.mjs:2134` — Add a CLI-level test that fails when the probe is removed or stubbed to a no-op, and ban blanket empty-evidence fixtures unless a sibling test asserts non-empty evidence refuses.
4. `we:scripts/verify-lane.mjs:834` — Require one test per heartbeat entry point, each of which fails when that entry point alone is removed.
5. `we:scripts/lane-pool.mjs:2062` — A check:standards rule requiring any script that spawns `lane-pool acquire` from a daemon to set LANE_HOLDER_PID, or have acquire refuse to record a PID that is a known daemon or init.
6. `we:scripts/lib/lane-lease-liveness.mjs:43` — Default every evidence field of a safety decider to null (unknown), and add a table test that includes the omitted-argument rows.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7179@172952efb9141b165bc6512eb6e693c5224593d1

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
