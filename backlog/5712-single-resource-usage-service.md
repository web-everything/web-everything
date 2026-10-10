---
bornAs: x6woyws
kind: epic
priority: high
parent: "3383"
status: open
dateOpened: "2026-10-09"
tags: []
---

# Single resource-usage service: one sampler, one admission library, one policy block

Every daemon judges 'machine busy' its own way: load-flake re-arm (load average per core), daemon rebuild smoke (load-scaled timeouts + hostLooksBusy), builder cost admission (CPU idle %, WE_COST_ADMISSION), heavy-slot load admission (we:scripts/readiness/heavy-admission.mjs), light-launch caps. macOS load average counts disk waits, so on 2026-10-09 it read 49-82 while the CPU was 37-46% idle (fseventsd ~180% from file churn across ~100 lanes), wrongly holding work and refusing rebuilds. Ratified design (operator, 2026-10-09 18:25 ET): ONE sampler, a job on the job model (#4125), sampling every ~10 s CPU idle %, memory pressure, disk busy, fseventsd CPU, heavy slots in use, live agent sessions, lane count, writing one snapshot with freshUntil to the coordination root; ONE reader library we:scripts/lib/resource-admission.mjs admit({kind}) returning {verdict: admit|wait|hold, reason, projectedWaitMinutes, snapshotAge}; a stale or missing snapshot = unknown (hold heavy kinds, admit light kinds, always logged); ONE policy block resolved through the policy cascade (standard default, then Platform Forever preference, then tool override) with thresholds per job kind (build, prepare, fix, ci-heal, review, rebuild-smoke, load-flake-rearm, light) — no gate keeps its own threshold afterwards; visible through the resource-status operation of we:scripts/operations/run.mjs. Rollout: (1) sampler + library + shadow logging; (2) cut over load-flake re-arm + rebuild smoke; (3) cost admission + heavy admission; (4) delete the old checks.

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
