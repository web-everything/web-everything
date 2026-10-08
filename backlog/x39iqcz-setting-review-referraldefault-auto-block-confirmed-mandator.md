---
kind: story
size: 5
status: open
scope: ["we:scripts/conveyor/referral-auto-block.mjs", "we:scripts/conveyor/review-hold-reconcile.mjs", "we:scripts/lib/review-settings.mjs", "we:scripts/lib/jury-core.mjs", "we:scripts/lib/ruling-ledger.mjs", "we:scripts/operations/record-referral-ruling.mjs", "we:scripts/operations/coroner-rounds.mjs", "we:scripts/review-settings.json", "we:scripts/conveyor/__tests__/referral-auto-block.test.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Setting review.referralDefault: auto-block confirmed mandatory referrals back to the fixer

Operator 2026-10-08: confirmed mandatory referrals are ruled block automatically by actor auto-policy and sent back to the fixer; operator sees only judgment calls and disputes. Setting review.referralDefault=operator|auto-block, product default operator, ours auto-block.

## Done when

1. **Executable** — `npx vitest run referral-auto-block` passes: in auto-block mode a confirmed referral is ruled `block` by actor `auto-policy`, sent back, and `advisory:ruling-needed` is not added; in operator mode nothing changes; a finding the fixer keeps missing past the miss limit is a dispute and stays with the operator. Fails before this item lands (no auto-policy actor, no sweep).
2. **Must refuse** — `auto-policy` can only rule `block`: a card or not-real ruling by it, or a hand-built clearing record, is invalid. It never touches `review:human`. A failed ruling is reported and the PR stays parked for the operator.
3. **Setting** — `review.referralDefault` is `operator` (product default) or `auto-block` (`we:scripts/review-settings.json`, ours); env `WE_REVIEW_REFERRAL_DEFAULT` overrides; junk keeps `operator`.

## Edge cases this change must handle

1. **Untrusted text** — the ruling reason is a fixed policy string; finding text is rendered through the existing inert-prose escape.
2. **Truncated reads** — n/a: reads the same PR thread the gate reads; a short read leaves the finding pending for the operator.
3. **Shared state files** — n/a: the only state is PR comments and labels.
4. **Fail closed** — any error, a judgment-call finding, a dispute or an unknown setting value leaves the finding for the operator.
5. **Identity scoping** — each ruling names repo, PR, head, run and finding key; it applies to that head only.
6. **State over time** — a block carried to a new head that the reviewer re-reports counts as a miss; past the miss limit it escalates to the operator.
7. **Who wrote it** — actor `auto-policy`, comment text says it is policy and not the operator; the operator can supersede it (card, not-real).
