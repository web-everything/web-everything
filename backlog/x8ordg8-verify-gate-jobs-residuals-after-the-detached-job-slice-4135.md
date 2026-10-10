---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/verify-gate-job.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# Verify gate jobs: residuals after the detached-job slice (#4135)

Follow-ups from 4135, seen live 2026-10-10. (1) The first launch for a new clone HEAD builds the readonly-tree snapshot synchronously inside the verify daemon tick (git archive + node_modules clone; 28 s live at 13:34:38Z-13:35:06Z), so that tick blocks; build snapshots off-tick or reuse the previous snapshot until the new one is ready. (2) When a gate supervisor dies and is relaunched while its gate still runs, the relaunch kills the surviving gate and re-runs it; it could instead re-attach to the surviving gate and settle it. (3) verify-lane notice lines now land in the job log under ~/.claude/daemon-jobs/verify-daemon/ instead of the daemon log; relay them. (4) "Is a gate alive" still fails open on a few edges (found by PR 4764 round-1 self-review): the gate sidecar is written only after the gate spawns, so a supervisor killed between spawn and write leaves a live gate with no sidecar; [fixed in PR 4764 round 3: a sidecar with `handle: null` (process start time unreadable), a `foreign` host handle or a throwing probe now reads `unknown` — the lane is held and nothing is killed or started; a foreign handle stays held until its job record ages out after 6 hours, so a hostname change can hold a lane that long] `runGateStep` and the tick side only look at their own job id's sidecar, so a survivor recorded under an earlier job id for the same lane is invisible to a new job; liveness checks the group leader only, not the rest of the process group (we:skills-src/conveyor/verify-daemon.mjs already treats "leader gone, group alive" as real). Still open: write the sidecar before or at spawn, and check every sidecar for the lane. (5) [fixed in PR 4764 round 3: rolling back with `WE_VERIFY_GATE_AS_JOB=0` still syncs the job store each tick, so a job-supervised gate holds its lane; only new gates run in-process.] (6) A held survivor lane (unkillable gate) has no age escalation or alert beyond one log line. Done when: unit tests per item and a live tick log showing no snapshot stall.

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
