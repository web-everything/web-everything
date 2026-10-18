---
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

- [A1] **Executable** — a vitest case in `we:scripts/conveyor/__tests__/review-referral-hold.test.mjs` replays the #5549 sequence (head aa45975 cleared by the operator, the auto-policy blocks carded `we:backlog/xildp3y.md`, then df9ee2d with the same finding under a new auto-policy block) and asserts `blockRuledReferralsFor` and the reconcile pass dispatch no fixer. It fails before the fix and passes after, run through the heavy-admission queue.

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
