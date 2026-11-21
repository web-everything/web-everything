---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/verify-lane.mjs", "we:scripts/lane-pool.mjs", "we:scripts/__tests__/verify-lane.test.mjs", "we:scripts/__tests__/lane-pool.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — For each heartbeat or renewal call site, add a unit test that disables the other renewers and ass… (from web-everything/web-everything#7179 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/verify-lane.mjs:831` — For each heartbeat or renewal call site, add a unit test that disables the other renewers and asserts a renewal still occurs. Alternatively, a lint or test-plan check that every new export parameter (`laneCwd`) has a test passing it.
2. `we:scripts/lane-pool.mjs:2058` — Add a check:standards rule that every non-test `we:scripts/lane-pool.mjs acquire` invocation in conveyor or dispatcher code sets `LANE_HOLDER_PID`. Alternatively, have acquire refuse to stamp PID 1 or a known daemon parent.
3. `we:scripts/lane-pool.mjs:1050` — Add a test-plan convention that every operator-facing recovery string or audit-journal entry named in a doc or comment gets an exact-string assertion in the CLI test that triggers it.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7179@90c488e827fc5b989ea87352236fd326201744c8

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
