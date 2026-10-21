---
bornAs: xptmosq
kind: story
size: 2
status: open
scope: ["we:scripts/lib/ledger-promotion-readiness.mjs"]
dateOpened: "2026-10-15"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5195 (head e78c20014)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5195 (reviewed head `e78c2001470d30be1f154d8abbb27f9418443883`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/ledger-promotion-readiness.mjs:95` — (failing-input, degraded) Replay marks missing verdicts resolved even when the writer creates no fact
   - Scenario: For an empty ledger and a merge candidate at a×40 with reviewGate.acceptedMerge:true, shadowRow reports disagreement with no-ledger-row. projectDrainFactsRow changes it to agreement, but planDrainLedgerFacts returns []: exemptions require reviewExempt:true and restamps require an existing clearing verdict. The actual disagreement therefore remains. Probes also show the projection hiding an unruled referral behind no-ledger-row. Replay should retain these disagreements unless the actual planned facts demonstrably resolve them.
   - Claude's re-check: projectDrainFactsRow strips no-ledger-row, stale-acceptance and hold:drain:* from any ledger-holds-label-clears row and marks it agree. It never checks whether a fact would be written. planDrainLedgerFacts returns [] for an empty ledger with acceptedMerge, because a restamp needs an existing clearing verdict and an exemption needs reviewExempt. So the projection overstates agreement.

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
