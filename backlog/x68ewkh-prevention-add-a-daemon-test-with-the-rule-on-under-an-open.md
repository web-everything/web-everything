---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:skills-src/conveyor/build-dispatch-daemon.mjs", "we:skills-src/conveyor/__tests__/build-dispatch-cost-admission.test.mjs", "we:scripts/conveyor/tick-core.mjs", "we:scripts/lib/cost-admission-facts.mjs", "we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs", "we:scripts/conveyor/__tests__/tick-core.test.mjs", "we:scripts/lib/__tests__/cost-admission-facts.test.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# Prevention — Add a daemon test with the rule ON under an open-PR freeze that asserts tickCapacity(tick).free;… (from web-everything/web-everything#4512 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:skills-src/conveyor/build-dispatch-daemon.mjs:1981` — Add a daemon test with the rule ON under an open-PR freeze that asserts tickCapacity(tick).free; better, route both consumers through one freezeHolds-derived field.
2. `we:skills-src/conveyor/__tests__/build-dispatch-cost-admission.test.mjs:96` — Let policyFrom or readCostAdmissionSettings take a path or file override and point the test at a temp file; add a missing-file case.
3. `we:scripts/conveyor/tick-core.mjs:1407` — Add a deterministic contract test requiring planner and launch admission to agree for identical budget, concurrency, CPU, and memory facts, with lane allocation tested separately.
4. `we:scripts/conveyor/tick-core.mjs:1540` — Add deterministic parameterized integration tests requiring each wired launch path to refuse independently on budget, concurrency, CPU, and memory limits.
5. `we:scripts/lib/cost-admission-facts.mjs:67` — Key the cache by ET day and add a deterministic reader test spanning midnight within the cache TTL.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4512@ec320483155ca574fc14c0519e3efea337e4ecec

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
