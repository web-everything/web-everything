---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:skills-src/conveyor/build-dispatch-daemon.mjs", "we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs"]
dateOpened: "2026-11-20"
tags: []
---

# Prevention — Add a daemon test that drives a planning skip across two ticks and asserts the durable store. The… (from web-everything/web-everything#7251 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:skills-src/conveyor/build-dispatch-daemon.mjs:1389` — Add a daemon test that drives a planning skip across two ticks and asserts the durable store. The cheaper option is to document in the daemon comment that only launch-guard refusals are durable and to file the planning-skip persistence as slice 2/3.
2. `we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs:1990` — Add a daemon-level test that runs the real tick-core `planTick` with an unreadable refusal file and asserts zero `dispatch` calls. Also assert that a missing `readPrepareRefusals` adapter fails closed in live mode.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7251@1ebcb27a6a67b0f157e2ca79ee9bb2e9c98d79f5

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
