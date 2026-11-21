---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/fix-dispatch-claim.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Red-team follow-ups [theoretical-race] from web-everything/web-everything#7271 (head 5913cb3b4)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7271 (reviewed head `5913cb3b45f7861cc4041b42bbabef2f8fa0cff9`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/fix-dispatch-claim.mjs:414` — (edge-case, broken) A heartbeat renewed during the listing read does not prevent stale-claim release.
   - Scenario: Start with a runnerless claim whose claimedAt and heartbeat are 31 minutes old. After listFixDispatchClaims snapshots it, renew its heartbeat while listAgentsAll runs, then return an unrelated named agent. The sweep still deletes the claim and emits session-gone: staleHeartbeat uses the original snapshot, while readUnchangedClaim ignores heartbeat changes. The renewed claim should remain held; deleting it permits duplicate dispatch.
   - Class: theoretical-race (basis: Deterministically reproduced by evaluating the production module with an in-memory claim store and renewing its heartbeat inside the injected listing callback. Both the unchanged control and renewed case released the claim. Production occurrence assumes another process renews the heartbeat during listing; concurrent live daemons were not exercised.)
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
