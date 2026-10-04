---
bornAs: xb4cxjl
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/soak/run-shard.mjs", "we:scripts/__tests__/vitest-worker-cap.test.mjs", "we:scripts/__tests__/heavy-run-admitted-callers.test.mjs", "we:scripts/conveyor/soak/__tests__/run-shard.test.mjs"]
dateOpened: "2026-10-04"
tags: []
---

# Prevention — Lint rule in check:standards flagging npx pkg without --no-install in scripts/**. (from web-everything/web-everything#3930 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/soak/run-shard.mjs:32` — Lint rule in check:standards flagging `npx <pkg>` without `--no-install` in scripts/**.
2. `we:scripts/__tests__/vitest-worker-cap.test.mjs:10` — Add a deterministic isolated-import test with an explicit worker cap different from both 4 and the computed default, asserting the exported maxTestWorkers value.
3. `we:scripts/__tests__/heavy-run-admitted-callers.test.mjs:43` — Add deterministic child-process boundary tests asserting that both callers pass admittedArgv's returned file and args to their launch functions.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#3930@3ed5f468746f0b8a3ccc66ba96824578c006ad36

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
