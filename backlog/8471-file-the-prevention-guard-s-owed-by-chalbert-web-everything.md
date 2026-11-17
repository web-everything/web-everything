---
bornAs: xeyqugp
kind: story
size: 3
status: open
scope: ["we:scripts/readiness/dispatch-plan.mjs", "we:scripts/conveyor/queue-scope.mjs", "we:scripts/conveyor/queue-store.mjs", "we:scripts/conveyor/queue.mjs", "we:scripts/readiness/__tests__/dispatch-plan.test.mjs", "we:scripts/conveyor/__tests__/queue-scope.test.mjs", "we:scripts/conveyor/__tests__/queue-store.test.mjs", "we:scripts/conveyor/__tests__/queue.test.mjs"]
dateOpened: "2026-09-29"
tags: []
---

# File the prevention guard(s) owed by chalbert/web-everything#2914's independent review

Filed mechanically by the unattended review loop (#2749) — every finding below reduced chalbert/web-everything#2914's review (reviewed head `fa82abbbcc84a52d3c1f240120051e44f92e6900`) to prevention-outstanding by naming a guard neither captured nor filed:

1. `we:scripts/readiness/dispatch-plan.mjs:800` — Add an integration test (or convert the soak break) that spawns `we:scripts/readiness/dispatch-plan.mjs` and `we:conveyor-state.mjs` against a fixture backlog and a stale-hash sidecar, and asserts that the card launches or reads as buildQueued. A shell-level regression test for the read path is the only guard that can catch a dropped wiring line.
2. `we:scripts/conveyor/queue-scope.mjs:327` — Route all sidecar reads through one resolving reader, or add a lint that flags a direct `readQueueFile` call outside that helper.
3. `we:scripts/conveyor/queue-store.mjs:148` — Add a `check:standards` rule, or a guard inside bornAsIndexFromItems, requiring bornAs to match the JIT-hash shape and be non-numeric. Add a unit test that a numeric or non-hash `bornAs` is not indexed.
4. `we:scripts/conveyor/queue.mjs` — Require 100% branch coverage on CLI commands or a standard practice of testing the error/fallback branches of best-effort loaders.
5. `we:scripts/readiness/dispatch-plan.mjs` — End-to-end JSON snapshot or integration tests for the `we:scripts/readiness/dispatch-plan.mjs` CLI that assert the full output payload under JIT-hash conditions.
6. `we:scripts/conveyor/queue.mjs:67` — A `check:standards` lint or AST rule enforcing that assertions made in docstrings ('never throws', 'safe no-op') must be paired with an explicit unit test simulating the failure mode.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.
