---
bornAs: x519de7
kind: story
size: 2
status: open
scope: ["we:scripts/lib/ledger-promotion-readiness.mjs"]
dateOpened: "2026-10-13"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5195 (head 10a0e297a)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5195 (reviewed head `10a0e297ae1335cd18ef981e6e10cd154ff320cf`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/ledger-promotion-readiness.mjs:95` — (edge-case, degraded) Replay projects agreement even when an unruled referral survives the new drain facts.
   - Scenario: Use o/r PR 1 at head 'a'.repeat(40), with one referral event naming findingKeys:['security-1'], no verdict rows, and a merge candidate with reviewGate.reviewExempt:true. shadowRow reports disagreement with ledgerHolds:['no-ledger-row'], masking the referral hold. projectDrainFactsRow removes that code and reports status:'agree'. However, planDrainLedgerFacts merely appends review-exempt; deriving the resulting events still returns clears:false with referral-unruled, and the actual shadow remains disagree. These outputs were reproduced with the real pure functions. Replay should preserve this d
   - Claude's re-check: The diff changes shadowRow so a PR with no verdict history reports only ['no-ledger-row'] and drops derived holds such as an unruled referral. projectDrainFactsRow treats a row whose only code is no-ledger-row as resolved and returns agree. The writer only appends review-exempt, which clears the verdict-less state but not a referral hold. Replay can therefore overstate agreement. That an unruled referral keeps a hold in derive is inferred from the claim, not shown.

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

## Also raised by

- Also raised by web-everything/web-everything#5195 (finding 2: `we:scripts/lib/ledger-promotion-readiness.mjs:95` — failing-input, degraded Replay projects agreement for PRs whose unruled referrals still block clearance.)
- Also raised by web-everything/web-everything#5195 (finding 1: `we:scripts/lib/ledger-promotion-readiness.mjs:95` — failing-input, degraded Replay projects agreement for disagreements the new drain facts cannot resolve)
