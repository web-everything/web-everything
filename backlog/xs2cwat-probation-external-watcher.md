---
kind: task
workItem: task
status: open
dateOpened: "2026-11-16"
tags: []
related: ["89", "8409"]
---

# S2c: externally observe probation startup and stalled ticks

R952/R955 accepts two R825-class residuals for PR #6882 S2a: r1, a process crashes while loading modules before its boot hook; r2, a tick hangs forever and never reaches the next boundary. Code inside that process cannot enforce either case while it is unavailable.

## Acceptance

- Give an external health-watch daemon or versioned current-pointer controller responsibility for r1; bind all recovery evidence to adoptionId.
- Observe r2 independently of the watched tick and preserve clone lease exclusion during recovery.
- Test a module-load exception before bootProbation and a never-settling tick using real child processes.
- Keep rollback mutations under withProbationLock and HEAD changes under the clone write lock.

## Interim

S2a enforces the absolute deadline on the next successful boot. Existing tickStarvedSmell alerts the operator about r2. Automatic recovery of r1 before that boot is not provided; the interim cannot guarantee recovery if every module load fails. These residuals are explicit, not claims of safety.
