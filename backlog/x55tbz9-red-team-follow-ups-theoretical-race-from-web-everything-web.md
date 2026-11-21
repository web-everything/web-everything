---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/fix-dispatch-claim.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Red-team follow-ups [theoretical-race] from web-everything/web-everything#7271 (head 54982b665)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7271 (reviewed head `54982b665fea34f3e28394d654194f3ef9d17bd1`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/fix-dispatch-claim.mjs:452` — (edge-case, broken) A heartbeat renewed during listing does not prevent stale release
   - Scenario: Start with a runnerless fix claim whose claimedAt and heartbeat are 31 minutes old, with leaseMinutes=10. During listAgentsAll, renew its heartbeat to now without changing owner, claimedAt, or runnerPid, then return one unrelated agent. An in-memory probe running the production claim and lock-store code returned released with reason session-gone and deleted the freshly renewed claim. staleHeartbeat uses the pre-listing snapshot, while readUnchangedClaim ignores heartbeat changes. Recheck heartbeat freshness and lease expiry on the reread before releasing; otherwise another dispatcher can acqui
   - Class: theoretical-race (basis: The failing interleaving was reproduced deterministically through an injected listing callback and an in-memory filesystem. Real occurrence requires another process to renew the claim during the listing interval; concurrent live daemons were not exercised.)
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
