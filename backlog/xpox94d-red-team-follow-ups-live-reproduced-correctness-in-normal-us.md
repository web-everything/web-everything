---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/resource-pool-io.mjs"]
dateOpened: "2026-11-23"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7353 (head 36b035080)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7353 (reviewed head `36b0350804ace2cd6d227f479333808078f2f18d`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/resource-pool-io.mjs:218` — (edge-case, degraded) Dead heavy-slot records remain counted as live C3 workers indefinitely.
   - Scenario: Leave three fix heavy-slot lock records after worker crashes, with distinct sessions fix-1 through fix-3, dead PIDs, and heartbeatAt 2026-11-20T00:00:00.000Z. At 2026-11-23T00:00:00.000Z, provide no live lane leases or fix claims and a fresh 30-unit snapshot. The collector reports known C3 usage of 6 and holds a hypothetical fix for 'class max', while the existing reclaim rule marks every slot acquirable because its PID is dead. The heavy-source path never checks liveness or expiry. Proven-dead records should be excluded from live-worker usage; ambiguous evidence should remain unknown.
   - Class: live-reproduced (basis: Reproduced with the unchanged production module evaluated in memory using injected lane/heavy source readers because direct import lacked gray-matter. The collector returned unknown=false, digest 'pool studio 6/30u · C2 0 C3 6 (floor 4)', and fix poolDecision=hold versus legacyDecision=grant. The actual reclaimDecision implementation returned pid-dead for all three records. Impact is confined to shadow accounting and comparison evidence.)
   - Also class: correctness-in-normal-use
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
