---
kind: story
size: 3
status: open
scope: ["we:scripts/readiness"]
dateOpened: "2026-10-31"
tags: []
---

# Remote slot reaper: reap leaked Forge slot-N.unconfirmed markers (parked branch, low priority)

Parked work, low priority after #6114 fixed the receipt-resources leak: lane/remote-slot-reaper@f5284d41bc770aaf8b392ee636ce580d32e948e3 reaps leaked slot-N.unconfirmed markers (JSON marker with runId/slot/startedAt/pid/host; reap-remote CLI; remote-slot-reaped event). Codex audits found 4 defects, fixed in rounds 2-5: (1) process age is not proof of termination (prepare/run are separate processes), so only whole-host-idle clears; (2) a live owner pid is never reaped, idle is rechecked right before unlink; (3) idle is read per marker host, not hardcoded forge; (4) lease-first: the reaper takes the slot-N lease, then rechecks and unlinks. Round-5 audit verdict not run, full verify not run, no PR. Caveat: Forge is rarely idle (activeRuns 3-6), so idle-only clearing seldom fires; the real fix needs Forge to persist the prepare label per run.

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
