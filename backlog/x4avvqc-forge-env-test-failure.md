---
kind: story
size: 2
status: open
scope: ["we:codex-direct-task.test.mjs"]
dateOpened: "2026-11-02"
tags: []
---

# Forge-env test failure

MED priority hint. - (2026-10-31 16:28 ET) Forge-env test failure: we:codex-direct-task.test.mjs 'kills a same-group straggler' fails on Forge with and without #6140 (passes on Mac). Make it pass on Forge or mark env-dependent with a reason (evidence: worker a1218e29 run on lane-44, 320/321). - Remote slot reaper (parked, low priority after #6114 fixed the receipt-resources leak): lane/remote-slot-reaper@f5284d41bc770aaf8b392ee636ce580d32e948e3. Reaps leaked slot-N.unconfirmed markers (JSON marker with runId/slot/startedAt/pid/host; reap-remote CLI; remote-slot-reaped event). Codex audits found 4 defects, fixed in rounds 2-5: (1) process-age is not proof of termination (prepare/run are separate processes) so only whole-host-idle clears; (2) live owner pid must never be reaped, recheck idle right before unlink; (3) idle must be read per marker host, not hardcoded forge; (4) path-unlink after identity check races a new dispatch, so design is lease-first: reaper takes the slot-N lease, then rechecks and unlinks. Round-5 audit verdict not run; full verify not run; no PR. Caveat: Forge is rarely idle (activ

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
