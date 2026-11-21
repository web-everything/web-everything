---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs", "we:skills-src/conveyor/build-dispatch-daemon.mjs"]
dateOpened: "2026-11-20"
tags: []
---

# Prevention — Add a card-lint or review-gate rule that every clause in the Acceptance section must map to a nam… (from web-everything/web-everything#7247 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs:4440` — Add a card-lint or review-gate rule that every clause in the Acceptance section must map to a named test, or be explicitly marked 'manual/live'.
2. `we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs:4440` — For any waived guard weakening, require a named test for the compensating control in the PR. Reviewers can map each Acceptance clause to a test name in a checklist, and a lint can flag an Acceptance clause with no matching test id.
3. `we:skills-src/conveyor/build-dispatch-daemon.mjs:560` — Add a check that `cliEffects()` exposes `readRuntimePriority`, and make live mode treat a missing reader as held. This is a deterministic unit test or lint.
4. `we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs:4435` — Add the named zero-build regression test to the CI suite, with eligible build candidates so the assertion cannot pass merely because no builds were available.
5. `we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs:4407` — Add a deterministic two-tick regression test to CI that carries bookkeeping forward and checks each tick's dispatched ids against the runtime list.
6. `we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs` — Add a deterministic integration test with an expired runtime list, explicit zero build capacity, and eligible build candidates; assert that no build dispatch occurs.
7. `we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs` — Add a deterministic two-tick test carrying bookkeeping and simulated claim state forward, asserting that every dispatched prepare member is listed and eligible listed work still launches.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7247@305f41eaab15616007d8e9121a139202b93de63d

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
