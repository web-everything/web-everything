---
kind: story
size: 5
parent: "xdlnylv"
status: open
blockedBy: ["x5qtv82", "xy5r0uf", "xbpjdsd"]
scope: ["we:scripts/lib/queue-branch-numbering.mjs", "we:scripts/merge-ai-prs.mjs", "we:scripts/settings/merge-queue-numbering.json", "we:scripts/check-standards.mjs", "we:scripts/lib/card-number-ledger.mjs"]
humanGate: { kind: review, what: "Operator confirms the replacement invariant in epic xdlnylv's decision note (every card on main has a ledger number assigned atomically at land; nothing on main references an unassigned id in a user-visible place), which supersedes the file-name half of #5057. Remove this gate once confirmed." }
dateOpened: "2026-10-13"
tags: [backlog, drain, merge-queue, numbering, ledger]
---

# Switch the drain to ledger numbering and relax the #5057 merge-group refusal

Slice (d) of epic xdlnylv: stop the pre-enqueue rename commit in we:scripts/lib/queue-branch-numbering.mjs; make the ledger the source of numbers; the merge_group gate refuses only unledgered x-id cards. Waits on the operator confirming the replacement invariant.

## Design

- Flip `we:scripts/settings/card-number-ledger.json` to `mode: on` and
  `we:scripts/settings/merge-queue-numbering.json` `numberCardsBeforeEnqueue` to `false`.
- In `we:scripts/merge-ai-prs.mjs:6539-6542`, replace the `prepareBranchBeforeEnqueue` call with
  `assignCardNumbers` (slice (a)) for the PR head's `x<6>` cards, inside `withNumberingLock`, before
  `mergeStrategy.enqueue` (:6545). In drain-direct mode, the same call runs before `mergePr` (:6548). No commit
  to the branch, no push to main; the judged head SHA is unchanged.
- If the assign fails, the candidate is skipped this pass (`decision = 'skip'`), exactly as a refused branch
  numbering is skipped today. The PR is never enqueued without its rows.
- Replace `mergeGroupHashRefusals` (we:scripts/lib/queue-branch-numbering.mjs:34-37; called at
  we:scripts/check-standards.mjs:787-789): refuse an `x<6>` card in the merge group only when the ledger has no
  row for it. The ledger is fetched in the merge_group job; an unreadable ledger refuses (fail closed).
- `sweepQueuedHashCards` (:318), `probeQueuedLand` (:354) and `repairHashOnMain` (:200) stop running when
  `mode: on`. A small replacement sweep assigns rows for any unledgered x-card found on main (no main push).

## MVP

The enqueue-path swap and the relaxed merge_group rule, both behind `mode: on`.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — card ids come from `git ls-tree` of the pinned head and must match `HASH_RE`; nothing
   else is passed to the ledger.
2. **Truncated reads** — a short or failed `ls-tree` skips the candidate this pass; it never enqueues with
   missing rows.
3. **Shared state files** — the ledger push is the only shared write; it runs under `withNumberingLock` and the
   push compare-and-swap.
4. **Fail closed** — no rows, no enqueue; no ledger in merge_group, no merge.
5. **Identity scoping** — rows record the PR number and repo; a PR in another repo writes its own file.
6. **State over time** — a dequeued and re-enqueued PR reuses its rows; a PR closed unmerged leaves a burned
   number (a gap), the same as today's reservations.
7. **Who wrote it** — only the drain writes rows; a PR cannot add its own row because the ledger is not on the
   PR branch.

## Test plan

Unit: the enqueue path calls `assignCardNumbers` and never `prepareBranchBeforeEnqueue` when `mode: on`; an
assign failure skips the candidate; the merge_group rule passes a ledgered x-card and refuses an unledgered one
and an unreadable ledger.

## Proof plan

Live, on the next real PR that carries a new card: before the switch, the drain log shows the `queue-numbering`
commit and a second CI run on a new head. After the switch, `gh pr view <N> --json commits` shows no drain
commit, the merged head equals the judged head, the ledger has the row, and the card's page shows its number.
Record the CI wall time of both runs.

## Done when

- Three consecutive real PRs with new cards land at their judged head with one CI round each.
- The merge_group gate refuses a test PR whose card has no ledger row.

## Acceptance

- [A1] **Executable** — the switch tests fail before this lands and pass after
  (`npm run test:unit -- we:scripts/lib/__tests__/queue-branch-numbering.test.mjs`).

## Non-goals

- [N1] Deleting the old rename code; that is slice (e).
