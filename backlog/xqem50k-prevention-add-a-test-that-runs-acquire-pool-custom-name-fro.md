---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lane-pool.mjs", "we:scripts/lib/lane-pool-origin.mjs", "we:scripts/__tests__/lane-pool-wrong-origin.test.mjs", "we:scripts/__tests__/lane-pool-acquire-growth.test.mjs", "we:scripts/conveyor/soak/breaks/lane-pool-wrong-repo-origin.mjs", "we:scripts/__tests__/lane-pool.test.mjs", "we:scripts/lib/__tests__/lane-pool-origin.test.mjs", "we:scripts/conveyor/soak/breaks/__tests__/lane-pool-wrong-repo-origin.test.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Prevention — Add a test that runs acquire --pool=custom-name from the pool's own primary checkout and expects… (from web-everything/web-everything#7419 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lane-pool.mjs:472` — Add a test that runs `acquire --pool=<custom-name>` from the pool's own primary checkout and expects success; or compare the caller's origin to the pool's lane origin instead of using names.
2. `we:scripts/lib/lane-pool-origin.mjs:10` — Add an originsDiffer table test covering scp-absolute, ssh://, https with port and user:pass forms.
3. `we:scripts/lane-pool.mjs:1830` — Require a positive-content assertion for any log message the PR text claims carries diagnostic detail.
4. `we:scripts/__tests__/lane-pool-wrong-origin.test.mjs:59` — Add a check that each Acceptance bullet in a lane-pool card maps to a named test in its Test plan.
5. `we:scripts/__tests__/lane-pool-wrong-origin.test.mjs:61` — Parameterise the soak break, or add a unit CLI test, over every `needsOrigin` command (acquire, provision, refresh, reclaim).
6. `we:scripts/lane-pool.mjs:1807` — Have laneIsWrongOrigin return a tri-state, and treat an unreadable origin as not eligible for the scan, like the probe-failure path.
7. `we:scripts/__tests__/lane-pool-acquire-growth.test.mjs:296` — Replace the negative string assertions with a shared exported constant, or a structured log field, that tests import.
8. `we:scripts/conveyor/soak/breaks/lane-pool-wrong-repo-origin.mjs:30` — Add the named behavioral test to we:scripts/__tests__/lane-pool-wrong-origin.test.mjs and run it as a deterministic regression gate.
9. `we:scripts/lane-pool.mjs:1829` — Add the named fault-injection test to we:scripts/__tests__/lane-pool-wrong-origin.test.mjs as a deterministic gate for diagnostic content and continued selection.
10. `we:scripts/lane-pool.mjs:482` — Add a deterministic CLI regression test with different owners but identical repository basenames, asserting the acquired lane's actual origin.
11. `we:scripts/conveyor/soak/breaks/lane-pool-wrong-repo-origin.mjs:30` — Add CLI tests invoking acquire --pool from another checkout without origin/reference overrides, asserting successful growth and recovery plus the returned lane's origin.
12. `we:scripts/lane-pool.mjs:1830` — Add a deterministic injected-probe-failure test asserting the actual error text, nonfatal diagnostic wording, and successful acquisition of a later eligible lane.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7419@8eb8b50d6f0120d12a8e3fab18b94c41f69fc71e

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
