---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs", "we:scripts/conveyor/ci-heal-loop.mjs", "we:skills-src/conveyor/__tests__/reconcile-fix-dispatch-daemon-ci-heal-loop.test.mjs", "we:skills-src/conveyor/__tests__/reconcile-fix-dispatch-daemon.test.mjs", "we:scripts/conveyor/__tests__/ci-heal-loop.test.mjs"]
dateOpened: "2026-11-20"
tags: []
---

# Prevention — Extract the child-supervisor wiring into a pure factory, e.g. buildDaemonChildren, that returns {… (from web-everything/web-everything#7248 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs:1941` — Extract the child-supervisor wiring into a pure factory, e.g. `buildDaemonChildren`, that returns `{awaitLoop, ciHealLoop, exits, effects}`. Test that factory so omitting the argument reddens it. Alternatively, make the parameters required (no `?.`) so a missing one throws.
2. `we:scripts/conveyor/ci-heal-loop.mjs:181` — Add a `cloneDispatchBlock` test for `knownIdentity: null` that pins whichever behaviour is intended. Make the child refuse to start when the boot identity is unreadable, so the fail-closed claim becomes true.
3. `we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs:1792` — File a reinforce-later card. Have the child write a last-completed-tick timestamp. The parent runs inline heal when that timestamp is older than N times the interval. Add a per-iteration timeout inside the child.
4. `we:scripts/conveyor/ci-heal-loop.mjs:183` — Add a loop-level test with the real `cloneDispatchBlock` and an injected `cloneIdentity` that changes mid-run. File a card for a lint that flags a pure helper whose only call-site test mocks the helper.
5. `we:skills-src/conveyor/__tests__/reconcile-fix-dispatch-daemon-ci-heal-loop.test.mjs:44` — Give `buildCliDaemonEffects` an injectable `runTick`, then assert that `ciHealInline` and `ciHealLock` equal the expected values when `current()` is truthy and when it is null. File a card to ban `.toString()` source-regex assertions in tests.
6. `we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs:1744` — File a card for an iteration deadline in the child (abort and exit non-zero so the supervisor restarts it), or an iteration-progress timestamp the parent checks before skipping inline.
7. `we:skills-src/conveyor/__tests__/reconcile-fix-dispatch-daemon-ci-heal-loop.test.mjs:24` — Add a named clock-controlled integration test, 'claims CI failures within ten minutes while the parent fix tick is blocked', asserting iteration timestamps and claim creation time; require that test in CI and attach the separately promised live measurement.
8. `we:scripts/conveyor/ci-heal-loop.mjs:179` — Add a deterministic regression test covering null boot and current identities with an absent marker, asserting that authentication and dispatch never run.
9. `we:skills-src/conveyor/__tests__/reconcile-fix-dispatch-daemon-ci-heal-loop.test.mjs:23` — Add a deterministic integration test with controlled time that holds the parent fix phase open and asserts the child claim timestamp against the stated bound.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7248@b89c1792d4f34b29e40a8c4de4411feb43fdb28f

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
