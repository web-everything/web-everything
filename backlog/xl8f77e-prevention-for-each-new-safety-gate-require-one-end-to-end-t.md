---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lane-pool.mjs", "we:scripts/readiness/heavy-admission.mjs", "we:scripts/verify-lane.mjs", "we:scripts/lib/lane-lease-heartbeat.mjs", "we:docs/agent/testing.md", "we:scripts/__tests__/lane-pool.test.mjs", "we:scripts/readiness/__tests__/heavy-admission.test.mjs", "we:scripts/__tests__/verify-lane.test.mjs", "we:scripts/lib/__tests__/lane-lease-heartbeat.test.mjs"]
dateOpened: "2026-11-20"
tags: []
---

# Prevention — For each new safety gate, require one end-to-end test with the gate's input forced to the refusin… (from web-everything/web-everything#7179 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lane-pool.mjs:2092` — For each new safety gate, require one end-to-end test with the gate's input forced to the refusing value. Add a lint or standards check that fails when an injected seam is stubbed to empty in every test of its consumer.
2. `we:scripts/readiness/heavy-admission.mjs:2183` — Give each heartbeat a test that asserts which component renewed the lease, or add an injection seam. Add a review checklist item: redundant safety paths must each be mutation-tested.
3. `we:scripts/lane-pool.mjs:2104` — Include `renewedAt` in `sameLease`, or re-check staleness under the lease guard inside `takeMarkerIf`. Add a regression test with a renewal injected between probe and take.
4. `we:scripts/lane-pool.mjs:2058` — Add `''` to the invalid-PID `it.each` table, or treat an empty value as unset. Add a standards check that env-var parsers list the empty string as a case.
5. `we:scripts/lane-pool.mjs:1038` — Add a test that asserts the refusal stderr contains the `release --pool= --lane= --force` command. Add an acquire test that asserts the marker contains `hostBootId`. Longer term, add a lint that maps each doc or comment guarantee sentence to a named test.
6. `we:scripts/verify-lane.mjs:831` — Add a unit test that calls `heartbeatOwnedSlot` with `laneCwd` and a seeded lease, and asserts `renewedAt` advances even when no slot is owned. Or drop the redundant path.
7. `we:scripts/lib/lane-lease-heartbeat.mjs:10` — Let the heartbeat take an expected session or holder (from `CLAUDE_CODE_SESSION_ID` or `LANE_SESSION`) and skip renewal on a mismatch. File it as a hardening card.
8. `we:docs/agent/testing.md` — Add a deterministic CLI test asserting the complete recovery command, including the affected pool and lane, to the scoped test gate.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7179@df425220e16e35c762f143c28d4d1d1e01d72bc9

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
