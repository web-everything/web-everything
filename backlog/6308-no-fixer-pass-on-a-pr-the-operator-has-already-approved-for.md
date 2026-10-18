---
bornAs: x84m5n2
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/"]
dateOpened: "2026-10-18"
tags: []
---

# No fixer pass on a PR the operator has already approved, for findings ruled card

Live 2026-10-18 #5549: the operator cleared it at head aa45975 (the 3 auto-policy coverage blocks superseded with card xildp3y). A fixer then pushed df9ee2d to address those carded findings, so the approval was lost and the same review questions came back. Fix: a finding ruled card (or not-real) never triggers a fixer pass, and a PR with a live human clearance on its head only gets a fixer pass for an open block ruling. Acceptance: [A1] Executable test replaying the #5549 sequence.

## Acceptance

- [A1] **Executable** — a vitest case in `we:scripts/conveyor/__tests__/review-referral-hold.test.mjs` replays the #5549 sequence (head aa45975 cleared by the operator, the auto-policy blocks deferred to card xildp3y, then df9ee2d with the same finding under a new auto-policy block) and asserts `blockRuledReferralsFor` and the reconcile pass dispatch no fixer. It fails before the fix and passes after, run through the heavy-admission queue.
- [A2] **Unmatched blocks and gate preservation** — executable cases in the same test file use an open blocked finding with no matching operator ruling and no human clearance. Assert `blockRuledReferralsFor` still returns the finding and the reconcile pass dispatches a fixer. Separately, matched `card` and `not-real` fixtures each include a distinct unresolved blocked referral: assert dispatch omits the carded or not-real finding but still includes that unresolved referral. Capture the underlying block gate result before and after dispatch filtering and assert it is unchanged, still blocked and still contains that exact unresolved referral.
- [A3] **Identity isolation** — executable table-driven cases in the same test file vary repository, PR, run and referral key independently, keeping the other three fields equal. For each of `card` and `not-real`, an exact-match operator ruling suppresses dispatch; a ruling differing in any one field cannot suppress the target finding. With no human clearance, assert the mismatched finding remains in `blockRuledReferralsFor`, the reconcile pass dispatches its fixer and its block gate remains blocked.
- [A4] **Latest operator ruling** — executable cases in the same test file cover both `card → block` and `not-real → block` for the same repository, PR, run and referral key, including a live human clearance on the current head. Assert the later operator block makes the finding appear in `blockRuledReferralsFor`, the reconcile pass dispatches a fixer and the block gate remains blocked. Include the reverse orders (`block → card` and `block → not-real`) as controls that suppress dispatch, so precedence is chronological rather than based on ruling kind.
- [A5] **Auto-policy is not human clearance** — an executable case in the same test file supplies only an `auto-policy` block on the current head, with no trusted operator clearance or ruling. Directly assert that the human-clearance result is absent and no operator ruling is recorded, that `blockRuledReferralsFor` retains the finding, that reconcile dispatches a fixer and that the block gate remains blocked. Additional cases place a newer auto-policy block after each trusted operator ruling (`card`, `not-real`, `block`) and assert it neither replaces that operator ruling nor supplies human clearance.

## Non-goals

- [N1] This item does not change how a reviewer rules a finding, how the auto-policy picks findings to block, or the same-head review pause. It only stops a card or not-real finding, or a cleared head's auto-policy block, from sending a fixer.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: the operator ruling and clearance are read by the existing trusted-author parsers, which this item does not change.
2. **Truncated reads** — n/a: a malformed ruling already holds the finding (no fixer pass); this item only filters blocks that were already read.
3. **Shared state files** — n/a: no new file is written; the fix is a pure filter in the dispatch-owed check.
4. **Fail closed** — the filter only removes a fixer pass. A finding it cannot match still goes to the fixer as before, so no block is dropped from the gate itself.
5. **Identity scoping** — the match uses the referral key that the gate already pins operator rulings to (same repo, PR, run and key).
6. **State over time** — a later operator block on the finding overrides an earlier card or not-real (the latest operator word decides).
7. **Who wrote it** — `auto-policy` never counts as the operator, so an auto-policy block alone never clears a finding and never counts as a human word on it.
