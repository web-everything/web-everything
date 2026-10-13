---
bornAs: x31o6hg
kind: story
size: 2
status: open
scope: ["we:scripts/lib/drain-ledger-shadow.mjs"]
dateOpened: "2026-10-13"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5195 (head 9eeab963a)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5195 (reviewed head `9eeab963ac7875844755d67b2c97328a98d7eab6`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/drain-ledger-shadow.mjs:118` — (failing-input, degraded) Replay reports agreement despite an unresolved referral that drain facts cannot clear.
   - Scenario: For o/r PR 1 at head a repeated 40 times, supply a valid review-exempt event followed by a referral event with findingKeys=['f-one'], no verdict rows, and a drain decision of merge. derivePrState correctly returns clears=false with hold 'referral-unruled'. shadowRow instead emits ledgerHolds=['no-ledger-row'], hiding the referral. projectDrainFactsRow then changes that disagreement to status='agree', projected=true. planDrainLedgerFacts returns [], proving no additional fact resolves this input. Preserve the actual derived hold alongside the missing-row marker so replay retains the unresolved
   - Claude's re-check: With no verdict rows, 'folded.history' is empty. The referral blocks 'clears', so 'derived.reviewExempt' is false and 'noRow' stays true. 'ledgerHolds' is then ['no-ledger-row'] instead of the referral hold. 'projectDrainFactsRow' treats that code as resolvable and flips the row to agree. The facts plan returns [] because the exemption already exists.

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
