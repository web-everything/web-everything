---
bornAs: xcsn887
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/health-watch.mjs", "we:scripts/conveyor/__tests__/health-watch.test.mjs"]
dateOpened: "2026-10-04"
tags: []
---

# Prevention — Run the sweep after the probes, or deduct the sweep's total elapsed time (lsof included) from the… (from web-everything/web-everything#3924 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/health-watch.mjs:797` — Run the sweep after the probes, or deduct the sweep's total elapsed time (lsof included) from the tick budget. Add a tick test with a slow `tmpSweepRun` that asserts total duration stays under `tickBudgetMs`.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#3924@00e74514a864a4e220b73d91005c02487cf07a60

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
