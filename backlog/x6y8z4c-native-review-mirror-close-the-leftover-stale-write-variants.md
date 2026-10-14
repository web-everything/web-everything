---
kind: story
size: 3
status: open
scope: ["we:scripts/lib/native-github-review.mjs", "we:scripts/lib/__tests__/native-github-review.test.mjs", "we:scripts/review-set-label.mjs"]
dateOpened: "2026-10-13"
tags: []
---

# Native review mirror: close the leftover stale-write variants (restamp ABA, a crashed writer)

Follow-up from PR #5223's red-team fix (card xk8ab41). The mirror in we:scripts/lib/native-github-review.mjs now skips a superseded verdict and re-reads labels after every attempted write. Two variants of 'a stale run overwrites a newer native review' remain. (1) ABA behind review:accepted: a stale restamp resumes after a newer accepted verdict on the same head; the labels read the same, so it counts as current and its dismiss-all plan removes the newer APPROVE. Closing it means either giving each verdict an identity the mirror can check, or deciding (operator) whether restamp should keep an own APPROVE pinned to the restamped head, which touches the round-2 ruling that rearm/restamp leave no bot verdict standing. Related, already true before #5223: a restamp dismissal queued under a non-reviewer token never removes the APPROVE, because the drain treats review:accepted as endorsing APPROVED. (2) A writer killed between its write and its re-read leaves its write unchecked; nothing reconciles native state to the labels afterwards. A periodic reconcile sweep (compare each open PR's native state to its labels) would close both.

## Acceptance

- [A1] **Executable** — `npm run test:unit -- we:scripts/lib/__tests__/native-github-review.test.mjs` with a new case: a stale `restamp` resumes after `changes` then `accepted` on the same head; GitHub must still show the newer APPROVE (fails today).
- [A2] **Executable** — a case where a writer stops between its POST and its re-read; a later reconcile pass leaves the native state matching the labels (fails today: nothing reconciles).
- [A3] The restamp question is put to the operator before (1) is built, since it may change the round-2 ruling.

## Non-goals

- [N1] Does not change what any verdict means on GitHub beyond what the operator rules; does not make the mirror a merge gate.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: no PR text is read or written; review bodies stay fixed text.
2. **Truncated reads** — the sweep reads reviews and labels with pagination and skips a PR whose read fails, never treating a partial list as complete.
3. **Shared state files** — the dismissal queue keeps its claim/append protocol; a sweep must not race the drain's claim.
4. **Fail closed** — any unreadable label or review read means no write.
5. **Identity scoping** — only the reviewer App's own reviews are posted or dismissed, under the reviewer token.
6. **State over time** — the verdict identity must survive a head move and a label value repeating (the ABA case).
7. **Who wrote it** — only reviews whose author is exactly the reviewer App (type Bot, exact login) count as ours.
