---
bornAs: x2bs2ap
kind: task
status: open
dateOpened: "2026-11-16"
tags: [daemon, probation]
related: ["8409"]
---

# S2b: adoption-bound outcome checks

Follow-up to PR #6882's S2a ruling. S2a proves process liveness from the previous
tick only. Restore application outcome checks in a separate slice after defining
how asynchronous results remain bound to an adoption UUID.

## Acceptance

- A1: A result for adoption B cannot promote, reject, delete or restart adoption C.
  Planned case `late outcome for B preserves C on pass failure and timeout` in
  `we:scripts/lib/daemon-rebuild/__tests__/probation.test.mjs` must assert C's
  probation, proven-good, rejection and rollback-marker bytes remain unchanged,
  with no restart after B settles in each of those three ways.
- A2: Re-read the adoption ID under the shared probation mutex after each await.
  Planned case `adoption replacement at each outcome await discards stale results`
  in `we:scripts/lib/daemon-rebuild/__tests__/probation.test.mjs` must replace B
  with C at every asynchronous boundary and assert no B mutation occurs after
  resumption; hold C's mutex to assert the revalidation waits for ownership.
- A3: Bound outcome execution and prevent tick overlap. Planned cases
  `hanging outcome expires within its budget without overlapping the next tick`
  and `failed outcome releases its execution slot before the next tick` in
  `we:scripts/lib/daemon-rebuild/__tests__/probation.test.mjs` must assert bounded
  settlement using a controlled clock, at most one active check, and that a late
  resolution after timeout cannot mutate evidence or start another restart.
- A4: Failed or hanging checks preserve caller drain and lease release. Planned
  case `outcome failure and timeout preserve caller drain and lease release` in
  `we:skills-src/conveyor/__tests__/runner-shutdown.test.mjs` must assert accepted
  work is drained, the read lease is released exactly once before restart, and
  no outcome timer calls process exit while drain is held.
- A5: Keep boot and adoption deadlines. Existing parameterized case
  `late healthy evidence cannot override the %s deadline` in
  `we:scripts/lib/daemon-rebuild/__tests__/probation.test.mjs` must keep both
  `boot` and `adoption` variants and assert failure plus a durable rollback
  marker even when a healthy tick has just arrived.
- A6: Keep no-reclaim and fail-closed behavior. Existing case
  `boot rollback preserves expired reader leases of unknown liveness` in
  `we:scripts/lib/daemon-rebuild/__tests__/probation.test.mjs` must assert unchanged
  reader entries and a retained marker on timeout. Planned case
  `unreadable rebuild state refuses promotion without a rollback marker: %s` in
  `we:scripts/lib/daemon-rebuild/__tests__/probation.test.mjs` must assert healthy
  evidence cannot promote, proven-good stays unchanged and probation remains.
  This promotion-only test is planned: the existing combined regression is
  bypassed by its pending marker (tracked by
  [the follow-up coverage card](/backlog/xpr688b-probation-unreadable-promotion-test/)).

## Non-goals

External observation of module-load crashes belongs to S2c.
