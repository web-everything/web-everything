---
bornAs: xnfeyop
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/health-watch.mjs", "we:scripts/operations/review-extra-seats.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5468 (head 8fd12417f)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5468 (reviewed head `8fd12417f9a94649084c160e3b6171a846d64a9b`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/health-watch.mjs:1359` — (failing-input, degraded) Normal queue polling falsely clears an ongoing disk-space alert.
   - Scenario: Open the disk episode at 9 GiB free, then run a successful needs-you queue poll with ready: []. The poll does not include host disk episodes, so diffFeed emits NEEDS-YOU-CLEARED and removes the disk key. Keep free space at 9 GiB: subsequent health ticks produce no opening transition and never republish it. Reproduced with the real episode core and feed diff functions. Polling should preserve externally published disk alerts until disk recovery explicitly clears them.
   - Claude's re-check: demonstrated break
2. `we:scripts/operations/review-extra-seats.mjs:1727` — (edge-case, degraded) Recheck timeouts leave children running in an untracked detached process group.
   - Scenario: A recheck CLI starts a long-running child with independent stdio, then exceeds its timeout. The new spawnFn detaches the CLI, but judgeSpawn's timeout calls child.kill('SIGKILL'), targeting only its PID. Its close event removes the tracked seat while its child survives. Reproduced through createRedTeamIo and real judgeSpawn with an inert Node CLI and a shortened 500 ms timeout: the child remained alive, ACTIVE_SEAT_PIDS was empty, and killActiveSeats() did nothing. Timeout handling should kill the process group before releasing tracking and scratch.
   - Claude's re-check: demonstrated break
3. `we:scripts/conveyor/health-watch.mjs:1359` — (failing-input, degraded) Disk attention publication ignores active tracked silences.
   - Scenario: Set a future-dated silence for smell disk-space, subject data-volume, with a tracking card, then observe 9 GiB free while no episode exists. The episode core correctly marks the opening as tracked and returns an empty notification plan. This new publication filter nevertheless selects that opening and sends a needs-you event. Reproduced using runHealthTick with the real disk descriptor: plan was empty while the publication filter selected the silenced episode. Attention publication should honor the tracked silence.
   - Claude's re-check: demonstrated break

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
