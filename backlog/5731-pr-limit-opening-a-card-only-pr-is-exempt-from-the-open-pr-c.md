---
bornAs: xbxahvf
kind: story
size: 2
parent: "4703"
status: open
scope: ["we:scripts/lib/pr-limit.mjs", "we:scripts/lib/__tests__/pr-limit.test.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# pr-limit: opening a card-only PR is exempt from the open-PR cap

Live 2026-10-10: the first card-batch draft (lane/card-batch-filing-1, 2 cards) was refused pr-limit at 17/15 open PRs. Since #4713 card-only PRs are not COUNTED toward the cap (we:scripts/lib/pr-limit.mjs countBackpressurePrs), but decideOpenPr still refuses to OPEN one when code PRs fill the cap, because only isExemptChangeset (infrastructure paths) bypasses the limit. A card-only opening adds nothing to the count it is refused on, and it blocks every batch draft and prevention card at exactly the moment the queue is busiest. Fix: in decideOpenPr, allow a changeset that isCardOnlyDiff (we:scripts/ci-card-only.mjs, the one definition) with reason 'exempt: card-only changeset (not counted)', before the limit check.

## Acceptance

- [A1] **Executable** — `npm run test:unit -- <test>` over we:scripts/lib/__tests__/pr-limit.test.mjs (strip the `we:` prefix to execute) passes with a new case: decideOpenPr with openCount 17, limit 15 and changedFiles of only new backlog cards returns allowed with the card-only reason; the same count with one non-card file is still refused.
- [A2] **Must (refuse on error)** — an empty or unreadable changed-file list is NOT card-only (fail closed, as isCardOnlyDiff already is), so it stays under the cap.
- [A3] **Live proof** — the held card-batch draft for lane/card-batch-filing-1 opens while the cap is full; record its PR number here.

## Non-goals

- [N1] Changing how PRs are counted (that is #4713).

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: only file paths from git diff are read.
2. **Truncated reads** — a diff that fails to resolve gives an empty list, which is not card-only, so the cap applies.
3. **Shared state files** — n/a: the decision is pure.
4. **Fail closed** — any non-backlog path in the changeset keeps the cap.
5. **Identity scoping** — per repo, as today.
6. **State over time** — n/a: decided per opening.
7. **Who wrote it** — n/a: authorship does not change card-only-ness.
