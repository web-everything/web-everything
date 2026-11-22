---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/fix-dispatch-claim.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Red-team follow-ups [theoretical-race] from web-everything/web-everything#7271 (head c6926aa86)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7271 (reviewed head `c6926aa8654b9a7bc1edf421d2f7711deb816d72`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/fix-dispatch-claim.mjs:414` — (edge-case, broken) A heartbeat renewed during the listing can still be deleted
   - Scenario: Start with a runnerless claim whose claimedAt and heartbeatAt are 31 minutes old. After the sweep snapshots it, renew its heartbeat while listAgentsAll runs, then return a nonempty listing without its owner. The sweep computes staleHeartbeat from the old snapshot; readUnchangedClaim checks owner, claimedAt and runnerPid but ignores the renewed heartbeat. It deletes the freshly renewed claim and emits session-gone. It should retain the claim because its current heartbeat has not passed the grace period or lease.
   - Class: theoretical-race (basis: Deterministically reproduced by evaluating the unchanged production module with in-memory dependency adapters and renewing heartbeatAt inside listAgentsAll. The claim was deleted despite its current heartbeat equaling nowMs. Production occurrence requires concurrent renewal during the listing; that concurrency was simulated, not observed live.)
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
