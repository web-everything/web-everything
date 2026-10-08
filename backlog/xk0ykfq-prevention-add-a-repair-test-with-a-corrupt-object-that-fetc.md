---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lane-pool.mjs", "we:scripts/lib/lane-repair.mjs", "we:scripts/__tests__/lane-pool-shared-commit-graph.test.mjs", "we:scripts/__tests__/lane-pool.test.mjs", "we:scripts/lib/__tests__/lane-repair.test.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Prevention — Add a repair test with a corrupt object that fetch tolerates but checkout -B trips on, asserting… (from web-everything/web-everything#4387 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lane-pool.mjs:1905` — Add a repair test with a corrupt object that fetch tolerates but `checkout -B` trips on, asserting QUARANTINED in stderr and a healthy lane. Longer term, a coverage-on-changed-lines gate for scripts/*.mjs.
2. `we:scripts/lane-pool.mjs:869` — Reword the card line to say the lane-level repair still runs. Optionally add a test that holds the lock live and asserts acquire's outcome.
3. `we:scripts/lib/lane-repair.mjs:143` — Reuse an existing shared lock helper if one exists in scripts/lib. Otherwise reclaim by renaming the stale lock to a unique name and then mkdir.
4. `we:scripts/lib/lane-repair.mjs:22` — Require `!after.ok` (probe-confirmed damage) before any reclone, and keep the message regex only to trigger the non-destructive heal. Add a regression test where a healthy, dirty lane gets a corruption-matching fetch error and must not be quarantined.
5. `we:scripts/lib/lane-repair.mjs:163` — Reclaim by `renameSync(lockDir, lockDir + '.stale-' + pid)` (atomic, only one winner), and have release verify the `owner` pid is still ours. Treat EPERM as alive. Better still, reuse an existing shared lock helper if the repo has one, and enforce that via a standards rule against ad hoc mkdir locks.
6. `we:scripts/lib/lane-repair.mjs:169` — Add a deterministic concurrency test that pauses two reclaimers after observing the stale owner and asserts that only one repair enters the protected section; require it in CI.
7. `we:scripts/lane-pool.mjs:875` — Extend the live-lease integration test to force a corruption-shaped fetch failure and assert unchanged lane refs, configuration, and cache files; gate repairs on ownership.
8. `we:scripts/__tests__/lane-pool-shared-commit-graph.test.mjs:103` — Gate the boundary test on before-and-after file inventories and content hashes for configuration and object storage, excluding only the explicitly permitted commit-graph paths; include an unreachable object in the fixture.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4387@fc5cfef7d0243db5375cf0d5f56a3ec9a983631f

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
