---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/__tests__/lane-pool-lease-keep.test.mjs", "we:scripts/lane-pool.mjs", "we:scripts/conveyor/lease-reaper.mjs", "we:docs/agent/testing/lane-lease-renewal.md", "we:scripts/__tests__/lane-pool-lease-removal-races.test.mjs", "we:scripts/__tests__/lane-pool.test.mjs", "we:scripts/conveyor/__tests__/lease-reaper.test.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Prevention — Add a case that pauses release at its existing test barrier, rewrites renewedAt, resumes, and ass… (from web-everything/web-everything#7456 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/__tests__/lane-pool-lease-keep.test.mjs:72` — Add a case that pauses release at its existing test barrier, rewrites `renewedAt`, resumes, and asserts the marker is gone.
2. `we:scripts/lane-pool.mjs:5589` — Add a reclaim and a salvage case that force a refusal after the marker take, then assert that release by the old session names the expiry.
3. `we:scripts/lane-pool.mjs:2586` — Reject boolean values for valued flags in the shared flag parser, with a test for the space form.
4. `we:scripts/lane-pool.mjs:3933` — Add a table-driven test of expired-holder release across every release selector and identity form.
5. `we:scripts/conveyor/lease-reaper.mjs:1534` — File a card (or add it to LEASE-HARDEN): the reaper passes the judged lease version (acquiredAt, holder, renewedAt) to release, which refuses on mismatch, plus a barrier test that renews between the reaper verdict and the release.
6. `we:scripts/lane-pool.mjs:5586` — Add a named case in we:scripts/__tests__/lane-pool-lease-removal-races.test.mjs that forces a refusal after the marker take for reclaim and salvage (a failing salvage or a liveness refusal under the hold) and asserts that `release --session=<old>` names the expiry.
7. `we:docs/agent/testing/lane-lease-renewal.md:24` — Extend the parameterized regression gate across trim and both reclaim branches, forcing a refusal after marker removal and asserting that the expired session remains identifiable.
8. `we:scripts/__tests__/lane-pool-lease-removal-races.test.mjs:59` — Add deterministic refusal-after-marker-take regression cases that assert the expiry journal entry and subsequent release diagnostic.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7456@c2058ff507f21d7d935344a0eef4b0dbf8583172

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
