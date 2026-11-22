---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/__tests__/audit-on-ready.test.mjs", "we:scripts/conveyor/audit-on-ready.mjs", "we:skills-src/conveyor/review-daemon.mjs", "we:skills-src/conveyor/__tests__/review-daemon.test.mjs"]
dateOpened: "2026-11-22"
tags: []
---

# Prevention — When a test asserts that a collaborator is never called, require that the collaborator is a decla… (from web-everything/web-everything#7325 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/__tests__/audit-on-ready.test.mjs:82` — When a test asserts that a collaborator is never called, require that the collaborator is a declared parameter of the code under test, and review for tests that pass options the function does not read.
2. `we:scripts/conveyor/__tests__/audit-on-ready.test.mjs:66` — Add a unit test with an injected `exec` or `readFile` that makes the canonical gate emit an unreadable or truncated message. Review test names against their assertions.
3. `we:scripts/conveyor/__tests__/audit-on-ready.test.mjs:80` — Add a lint or test-standards rule that flags a test double passed in an options bag that the function under test never destructures. For this case, spy on the real writers (gh label and comment modules, child_process write calls) instead of an invented option.
4. `we:scripts/conveyor/audit-on-ready.mjs:43` — Make `exec` an injectable parameter of defaultAuditCheck and add tests asserting the spawn options and the unknown mapping. A review-lens checklist item, 'every prose guarantee in a comment has a named test', is the cheaper durable guard.
5. `we:skills-src/conveyor/review-daemon.mjs:1498` — Add a daemon-hook standard (a check:standards rule) that any new per-tick hook must declare a time or count budget. Alternatively, ship new observation hooks with mode `off` until the budget lands.
6. `we:skills-src/conveyor/review-daemon.mjs:1497` — Replace the unused counter with deterministic spies or rejecting fakes at actual write and dispatch boundaries, and run the named test in CI for both shadow and on modes.
7. `we:scripts/conveyor/audit-on-ready.mjs:42` — Add a deterministic subprocess seam and CI tests asserting timeout options and unknown classification on exercised failure paths.
8. `we:scripts/conveyor/audit-on-ready.mjs:14` — Add a CI test using deeply frozen eligible PR rows and asserting their contents remain unchanged after planning.
9. `we:scripts/conveyor/__tests__/audit-on-ready.test.mjs:73` — Instrument actual mutation boundaries in the named test and add a mutation check that inserting a write or dispatch makes it fail.
10. `we:scripts/conveyor/audit-on-ready.mjs:42` — Add a deterministic subprocess-boundary test asserting timeout and killSignal options and the resulting owed-unknown observation; require mutations removing the timeout or unknown mapping to fail.
11. `we:scripts/conveyor/audit-on-ready.mjs:14` — Add a named test comparing deeply snapshotted PR inputs after planning across eligible and skipped cases, and verify that an injected row mutation fails it.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7325@a2b6126c48108886f18e739c97256d80ac679526

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
