---
bornAs: xtl54o5
kind: story
size: 5
priority: high
parent: "4075"
status: open
blockedBy: ["4124"]
scope: ["we:skills-src/conveyor/runner.mjs", "we:scripts/conveyor/infra-blocked.mjs", "we:scripts/conveyor/reconcile-fix-dispatch.mjs"]
dateOpened: "2026-09-24"
tags: []
---

# Remaining adopters: runner mechanical passes, fix-dispatch infra-blocked resumes, and review dispatch launch as jobs

Slice of decision 4120 (daemon job model); audit we:reports/2026-09-24-daemon-blocking-antipatterns.md. Filed uncleared until 4120 is ratified; the shape below follows its bold defaults and changes with the ruling. Findings N1, F2. we:skills-src/conveyor/runner.mjs makeCliMechanicalPasses (302-430) runs 15 passes x 3 repos as awaited children; we:scripts/conveyor/infra-blocked.mjs resumeOpen blocks up to 20 min per entry, serially. Shape: each becomes a job kind with a per-daemon cap; the tick only starts and reads jobs. Done when: tests; LIVE proof: runner and fix-dispatch tick p90 under their interval over a day, from the timestamped tick log.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.
