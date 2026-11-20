---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/pr-stall-sweep.mjs", "we:scripts/lib/round-judge.mjs", "we:scripts/lib/__tests__/round-judge.test.mjs", "we:scripts/conveyor/__tests__/pr-stall-sweep.test.mjs"]
dateOpened: "2026-11-20"
tags: []
---

# Prevention — Whenever a diff adds a field to a classifier context, require a sweep-level test that asserts the… (from web-everything/web-everything#7237 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/pr-stall-sweep.mjs:308` — Whenever a diff adds a field to a classifier context, require a sweep-level test that asserts the field arrives. A check:standards rule could flag a changed we:scripts/conveyor/pr-stall-sweep.mjs with no matching change in its test file.
2. `we:scripts/lib/round-judge.mjs:172` — Add a sweep test in which the row is 'ruling-needed:referral-hold' with a stale-head hold. It should assert either that the judge still receives the thread, or that the outcome is explicitly operator-parked.
3. `we:scripts/lib/round-judge.mjs:148` — Add a negative test with an untrusted-login verdict. A cheaper durable guard is a mutation-probe step in review that removes each guard line and requires a named test to redden.
4. `we:scripts/lib/round-judge.mjs:147` — Add an ordering negative test, `[verdict(live), hold(live)]` expecting `referral-hold`. The same mutation-probe review step would catch this class.
5. `we:scripts/conveyor/pr-stall-sweep.mjs:306` — Require acceptance entries to reference named implemented or planned tests, and add the sweep integration test with assertions on judge invocation and the resulting verdict.
6. `we:scripts/lib/__tests__/round-judge.test.mjs:400` — Add independently qualifying fixtures named 'live-head mechanical bounce preserves hold', 'untrusted live-head verdict preserves hold', and 'settlement follows thread order despite timestamps'; gate them with targeted mutations of the corresponding guards.
7. `we:scripts/lib/round-judge.mjs:150` — Add a deterministic regression test containing a fenced live-head field and assert that detectRoundCap still returns referral-hold.
8. `we:scripts/conveyor/pr-stall-sweep.mjs:307` — Add the named sweep integration test to the automated test gate, asserting the judge trigger and propagated verdict.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7237@51c2cbb08e95c5c3df5cd1bcf77f67bf254ee05e

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
