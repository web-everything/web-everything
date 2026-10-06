---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/under-test.mjs", "we:vitest.setup.ts", "we:bun-test.preload.ts", "we:scripts/backlog.mjs", "we:scripts/lib/lane-pool-paths.mjs", "we:scripts/lib/gh-rest-read.mjs", "we:scripts/operations/ci-heal-pr-dispatch.mjs", "we:skills-src/conveyor/verify-daemon.mjs"]
dateOpened: "2026-10-06"
tags: []
---

# Runner-neutral under-test marker replacing env.VITEST guards

Goal: production code guards on env.VITEST (12 files, 16 checks), which blocks a Bun opt-in for the scripts tests (#5067 follow-up). Design: new we:scripts/lib/under-test.mjs exporting isUnderTest(env) = VITEST or WE_UNDER_TEST; replace each of the 16 checks (we:scripts/backlog.mjs:1078, we:scripts/lib/claude-agents-cache.mjs:8, we:scripts/lib/gh-rest-read.mjs:39,93, we:scripts/lib/lane-pool-paths.mjs:105, we:scripts/lib/pr-snapshot-store.mjs:37, we:scripts/lib/pr-snapshot.mjs:112, we:scripts/lib/salvage-index.mjs:74, we:scripts/lib/target-registry.mjs:604, we:scripts/lib/verdict-ledger.mjs:827, we:scripts/operations/ci-heal-pr-dispatch.mjs:79-85, we:scripts/operations/dispatch-providers/probation-worker.mjs:69, we:skills-src/conveyor/verify-daemon.mjs:77); set WE_UNDER_TEST=1 in we:vitest.setup.ts AFTER its WE_* env-strip block, and in we:bun-test.preload.ts. Done when: grep for env.VITEST in scripts and skills-src outside __tests__ returns only we:scripts/lib/under-test.mjs; new unit test (isUnderTest empty false, WE_UNDER_TEST true, VITEST true); guard test that lane-pool-paths still throws the never-touch-the-real-lane-pool error with only WE_UNDER_TEST set; existing lane-pool-paths and gh-rest-read tests pass. Risk: a missed site (the grep catches it). No Bun needed. Checklist: operator handoff checklist item 72a.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
