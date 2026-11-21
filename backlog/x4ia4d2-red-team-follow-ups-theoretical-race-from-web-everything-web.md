---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/fix-dispatch-claim.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Red-team follow-ups [theoretical-race] from web-everything/web-everything#7271 (head ab2e110ef)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7271 (reviewed head `ab2e110efc9141bdd4a380afc805a0912f06b1b0`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/fix-dispatch-claim.mjs:414` — (edge-case, broken) A heartbeat received during the listing probe does not prevent stale release
   - Scenario: Start with a runnerless fix claim acquired and last heartbeated at 12:00. Sweep at 12:31. During listAgentsAll, another writer heartbeats the same claim at 12:31 without changing owner, claimedAt, or runnerPid; the listing returns one unrelated named agent. The sweep releases the claim with reason session-gone despite its fresh heartbeat. It should retain the renewed claim. staleHeartbeat uses the pre-listing snapshot, and readUnchangedClaim does not compare heartbeatAt, allowing duplicate dispatch after renewal.
   - Class: theoretical-race (basis: Deterministically reproduced using the checked-out refresh and file-lock implementations with in-memory filesystem adapters: the claim was readable with heartbeatAt 12:31 immediately before being removed. Production impact assumes a concurrent heartbeat writer during the listing probe; overlapping production sweeps were not demonstrated.)
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
