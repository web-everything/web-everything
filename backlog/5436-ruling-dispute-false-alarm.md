---
bornAs: xlhcd5o
kind: story
size: 3
status: open
scope: ["we:scripts/lib/ruling-ledger.mjs", "we:scripts/lib/__tests__/ruling-ledger.test.mjs", "we:scripts/review-set-label.mjs", "we:scripts/__tests__/review-set-label.test.mjs", "we:scripts/conveyor/__tests__/reconcile-core.test.mjs", "we:scripts/operations/__tests__/record-referral-ruling-supersede.test.mjs", "we:scripts/operations/__tests__/record-referral-ruling-disputed.test.mjs", "we:scripts/conveyor/__tests__/fixtures/pr-4361-a5938d89-reviewer-cleared-dispute.json", "we:scripts/conveyor/__tests__/fixtures/pr-4433-4705dcf8-reviewer-cleared-dispute.json"]
dateOpened: "2026-10-08"
tags: []
---

# Ruling dispute false alarm: an older-head block the current-head reviewer ruled not-real still counts as came back

ignoredRulings (ruling-ledger) counts a block from an earlier head as 'came back' even when a reviewer on a later or the current head ruled the same finding not-real with evidence: auto-policy structured blocks ignore the current-head reviewer ruling, and record blocks ignore a later-head reviewer not-real (carried). Live #4361 (a5938d89), #4433 (4705dcf8), #4402: ruling-dispute note / owed-a-fix fired, operator superseded by hand. Fix: such a block is satisfied; only a genuinely re-raised block counts. Also clear advisory:ruling-needed on accept / clear-human (#4402 kept it after merge).

## Done when

1. **Executable** — `npm run test:unit` over we:scripts/lib/__tests__/ruling-ledger.test.mjs, we:scripts/conveyor/__tests__/reconcile-core.test.mjs and we:scripts/__tests__/review-set-label.test.mjs: the held-item-141 replays of #4361 (head a5938d89) and #4433 (head 4705dcf8) fail before (dispute / ruling-not-addressed fires) and pass after (none), while the same threads before the current-head rulings still fire; `accepted` and `clear-human` remove `advisory:ruling-needed`.
2. Must: a block genuinely re-raised on the current head (unruled, ruled block again, or cleared only by a not-real older than the block) still counts as came back.
3. Must: on any read error the gate state is treated as "not cleared" (the old behaviour), never as satisfied.

## Edge cases this change must handle

1. **Untrusted text** — records and operator rulings are only read from trusted authors (`readReferralRecords`, `readOperatorRulings`); nothing new is parsed.
2. **Truncated reads** — a malformed or truncated record is not read, so it clears nothing; the block still counts.
3. **Shared state files** — n/a: pure functions over the PR thread.
4. **Fail closed** — `referralRecordState` throwing leaves the finding uncleared (the old answer).
5. **Identity scoping** — the clearance is the gate's own counted ruling on that exact current-head finding key (a reviewer carry must pass `reviewerCarryBacking`'s identity checks).
6. **State over time** — the clearing not-real must be written after the block (thread position), so an older not-real never cancels a newer block.
7. **Who wrote it** — only rulings the gate COUNTS (independent reviewer, or the operator) clear a block; a forged or uncounted ruling does not.
