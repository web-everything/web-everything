---
bornAs: xvdf94x
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/lease-reaper.mjs"]
dateOpened: "2026-10-24"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5888 (head 7dec7849d)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5888 (reviewed head `7dec7849d4a01a0f5ef7f9a29e24b22a790a04c3`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/lease-reaper.mjs:1571` — (failing-input, degraded) Future-dated claims bypass freshness validation and suppress reclamation of dead leases.
   - Scenario: At now=2026-10-24T21:17:20Z, supply a fix-5848 claim with claimedAt=2026-10-24T21:15:47Z, heartbeatAt=2026-10-25T21:17:20Z, and a dead runnerPid. List only a stopped fix-5848 row started at 20:50Z with a confirmed-dead PID; its lease was acquired at 20:51Z with ttlMinutes=240. The future heartbeat passes listFixDispatchClaims({liveOnly:true}), although claimRunnerPidsBySession explicitly rejects it. The new staleTerminalNamesForClaims path nevertheless trusts this claim and suppresses both terminal-state and dead-PID evidence. A read-only probe using the checked-in signal builder and reap plan
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
