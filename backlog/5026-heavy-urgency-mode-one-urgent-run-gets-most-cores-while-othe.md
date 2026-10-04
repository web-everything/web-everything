---
bornAs: x72m4dn
kind: story
size: 5
parent: "3383"
status: open
scope: ["we:scripts/readiness/heavy-admission.mjs", "we:vitest.shared.ts", "we:config/platformDefaults.ts", "we:config/defineConfig.ts"]
dateOpened: "2026-10-03"
tags: []
---

# Heavy urgency mode: one urgent run gets most cores while other heavy slots pause

Operator ruling 2026-10-03. Today each vitest run is capped at 4 workers (maxTestWorkers in we:vitest.shared.ts) and heavy admission allows 3 runs (WE_HEAVY_ADMISSION_CAP), so one urgent run uses a third of the 12-core laptop; the #3787 fixer's local verify took 15+ min. Add an urgency mode to we:scripts/readiness/heavy-admission.mjs: when an urgent job asks for a slot, stop admitting new heavy runs, let running ones finish (never kill), then run the urgent job alone with more workers (default ~10, via a per-run env read by we:vitest.shared.ts instead of the fixed 4), and return to normal when it ends. Urgent triggers (configurable): a main-fix PR, the head of a blocked scope-overlap chain, an operator-pinned PR, optionally any fix while main is red. Settings per config-extends-platform-default (we:config/platformDefaults.ts, we:config/defineConfig.ts): normal/urgent workers, urgent slots, triggers, and a max urgent duration so it cannot starve the queue. Done when: tests cover admission switch, drain-then-run, worker env, max duration and return to normal; a live urgent verify on a real PR shows worker count and wall time before/after.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
