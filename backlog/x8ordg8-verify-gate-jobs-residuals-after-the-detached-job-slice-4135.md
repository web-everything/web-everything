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

Follow-ups from 4135, seen live 2026-10-10. (1) The first launch for a new clone HEAD builds the readonly-tree snapshot synchronously inside the verify daemon tick (git archive + node_modules clone; 28 s live at 13:34:38Z-13:35:06Z), so that tick blocks; build snapshots off-tick or reuse the previous snapshot until the new one is ready. (2) When a gate supervisor dies and is relaunched while its gate still runs, the relaunch kills the surviving gate and re-runs it; it could instead re-attach to the surviving gate and settle it. (3) verify-lane notice lines now land in the job log under ~/.claude/daemon-jobs/verify-daemon/ instead of the daemon log; relay them. Done when: unit tests per item and a live tick log showing no snapshot stall.

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
