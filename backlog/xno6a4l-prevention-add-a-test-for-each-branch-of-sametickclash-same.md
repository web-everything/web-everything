---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:skills-src/conveyor/__tests__/build-dispatch-multi-launch.test.mjs", "we:skills-src/conveyor/build-dispatch-daemon.mjs", "we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# Prevention — Add a test for each branch of sameTickClash (same num, build scope vs prepare scope, prepare vs p… (from web-everything/web-everything#4769 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:skills-src/conveyor/__tests__/build-dispatch-multi-launch.test.mjs:139` — Add a test for each branch of `sameTickClash` (same num, build scope vs prepare scope, prepare vs prepare). A review lens on 'prose guarantee needs a named test' covers this class; no deterministic gate fits.
2. `we:skills-src/conveyor/build-dispatch-daemon.mjs:659` — Have the daemon count its own same-tick launches into the gates: pass `startedThisTick` to the host-load gate as an in-flight bump and refresh or invalidate `costFacts` after each launch. Add a test that runs `cliHostLoadGate` with a fixed loadavg stub across N launches. Optionally default `maxLaunchesPerTick` to a small bound (e.g. 2–3) until the gates account for same-tick launches.
3. `we:skills-src/conveyor/__tests__/build-dispatch-multi-launch.test.mjs:122` — Add the two named cases to we:skills-src/conveyor/__tests__/build-dispatch-multi-launch.test.mjs and require them in the unit-test gate.
4. `we:skills-src/conveyor/__tests__/build-dispatch-multi-launch.test.mjs:96` — Add a parameterized prepare failure-isolation test covering throwing gates, claims, and dispatches to we:skills-src/conveyor/__tests__/build-dispatch-multi-launch.test.mjs and include it in the unit-test gate.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4769@d466e1f4e5affdf23b6d8a2b313989b9810539c0

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
