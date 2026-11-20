---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lane-pool.mjs", "we:scripts/__tests__/lane-pool-acquire-at-sha.test.mjs", "we:scripts/__tests__/lane-pool.test.mjs"]
dateOpened: "2026-11-20"
tags: []
---

# Prevention — Add a dirty-tree case, covering both conflicting and non-conflicting edits, to the discard it.eac… (from web-everything/web-everything#7208 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lane-pool.mjs:3667` — Add a dirty-tree case, covering both conflicting and non-conflicting edits, to the discard it.each in we:scripts/__tests__/lane-pool-acquire-at-sha.test.mjs and to the soak break. A review-lens checklist item, 'every --discard path is exercised with a dirty tree', is the cheapest durable guard.
2. `we:scripts/lane-pool.mjs:2259` — Add a fault-injection test that kills the acquire between claim and detach, then runs reap and expects the lane to be freed. A cheaper design guard is to write `at` into the lease only after a successful detach.
3. `we:scripts/__tests__/lane-pool-acquire-at-sha.test.mjs:131` — For each guarantee the PR prose states about an existing lock, require an end-to-end test that uses the lane as provisioned and tries each push destination the guarantee covers (main and the pinned lane branch). A review-lens checklist item is the cheapest option. A deterministic gate is hard to write for this.
4. `we:scripts/__tests__/lane-pool-acquire-at-sha.test.mjs` — Add a deterministic regression test targeting the pinned lane branch, then verify that disabling the lane push lock makes that named test fail.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7208@49abd5649c3441efa8c8d0115a3cc1d067781a38

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
