---
bornAs: x17044r
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/review-status-tag.mjs", "we:scripts/operations/record-referral-ruling.mjs", "we:scripts/conveyor/__tests__/review-status-tag.test.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# A ruling or send-back clears the stale review-status:needs-human label

Follow-up from #4502 (operator approved with follow-up 2026-10-09). After the operator rules on a PR (send-back with a ruling), the review-status:needs-human label stays on it, so the PR keeps reading as waiting on a human. The ruling/send-back path must clear it through the single review-status label writer (we:scripts/conveyor/review-status-tag.mjs), not a second writer.

## Acceptance

- [A1] **Executable** — `npm run test:unit -- we:scripts/conveyor/__tests__/review-status-tag.test.mjs` has a red-first case: a PR with a recorded operator ruling or send-back no longer derives review-status:needs-human.
- [A2] The label is cleared by the single review-status label writer (we:scripts/conveyor/review-status-tag.mjs); no second code path writes or removes review-status:* labels.
- [A3] **Observable** — on the next live ruling, the PR loses review-status:needs-human within one tick (before/after label list).

## Non-goals

- [N1] Changing what review:* verdict labels mean.
- [N2] Any change to how rulings are recorded in the ledger.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: this follow-up opens no new case of this class.
2. **Truncated reads** — n/a: this follow-up opens no new case of this class.
3. **Shared state files** — n/a: this follow-up opens no new case of this class.
4. **Fail closed** — n/a: this follow-up opens no new case of this class.
5. **Identity scoping** — n/a: this follow-up opens no new case of this class.
6. **State over time** — a later new head that needs a human again re-derives the label.
7. **Who wrote it** — only an operator-recorded ruling (not a bot comment) clears the label.
