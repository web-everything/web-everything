---
kind: story
size: 5
parent: "xdlnylv"
status: open
blockedBy: ["x5qtv82", "xy5r0uf", "xbpjdsd", "xg7whui"]
scope: ["we:scripts/lib/queue-branch-numbering.mjs", "we:scripts/merge-ai-prs.mjs", "we:scripts/settings/merge-queue-numbering.json", "we:scripts/settings/card-numbering.json", "we:scripts/check-standards.mjs", "we:scripts/lib/card-number-ledger.mjs", "we:scripts/lib/__tests__/queue-branch-numbering.test.mjs", "we:scripts/__tests__/merge-ai-prs.test.mjs", "we:scripts/__tests__/check-standards.test.mjs"]
dateOpened: "2026-10-13"
tags: [backlog, drain, merge-queue, numbering, ledger]
---

# Switch the card-numbering mode to rename-after-land (no code path removed)

Slice (d) of epic xdlnylv: make every numbering step obey `backlog.cardNumbering.mode`, then flip the repo to the default `rename-after-land`. The pre-enqueue rename in we:scripts/lib/queue-branch-numbering.mjs is turned off for the merge queue, not deleted. The invariant was confirmed by the operator on 2026-10-13 (epic decision note), so this slice has no humanGate.

## Design

- Mode-gate, do not delete. Every step below stays in the code and runs only in its mode:
  - `rename-before-enqueue`: `prepareBranchBeforeEnqueue` (we:scripts/lib/queue-branch-numbering.mjs:238),
    `sweepQueuedHashCards` (:318), `probeQueuedLand` (:354), `repairHashOnMain` (:200), and the
    `mergeGroupHashRefusals` merge_group refusal (:34-37, called at we:scripts/check-standards.mjs:787-789),
    exactly as today; the ledger row records the number the rename chose.
  - `rename-after-land` and `ledger-only`: `assignCardNumbers` (slice (a)) runs inside `withNumberingLock`
    just before `mergeStrategy.enqueue` (we:scripts/merge-ai-prs.mjs:6539-6545), or before `mergePr` in
    drain-direct. No commit to the branch; the judged head is unchanged. The merge_group gate refuses an
    `x<6>` card only when it has no ledger row (unreadable ledger: refuse).
- `numberCardsBeforeEnqueue` (we:scripts/settings/merge-queue-numbering.json) becomes derived from the mode
  (true only in `rename-before-enqueue`); an explicit old value is still honoured and logged as such.
- The flip: remove the repo override in we:scripts/settings/card-numbering.json that slice (a) added, so the
  standard default `rename-after-land` applies. Switching back is a one-line setting change.
- If the assign fails, the candidate is skipped this pass (`decision = 'skip'`); it is never enqueued without
  its rows.

## MVP

Mode-gating of the enqueue path and of the merge_group rule, then the flip.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — card ids come from `git ls-tree` of the pinned head and must match `HASH_RE`.
2. **Truncated reads** — a short or failed `ls-tree` skips the candidate this pass; it never enqueues with
   missing rows.
3. **Shared state files** — the ledger push is the only shared write; it runs under `withNumberingLock` and the
   push compare-and-swap.
4. **Fail closed** — no rows, no enqueue; no ledger in merge_group, no merge; an invalid mode value falls back
   to the lower cascade layer and is logged.
5. **Identity scoping** — rows record the PR number and repo; a PR in another repo writes its own file.
6. **State over time** — a mode change mid-flight is safe: PRs already renamed land as numeric cards; x-id cards
   already on main are picked up by the rename batch (slice (f)) or stay x-id under `ledger-only`.
7. **Who wrote it** — only the drain writes rows; a PR cannot add its own row because the ledger is not on the
   PR branch.

## Test plan

Unit, per mode: `rename-before-enqueue` still calls `prepareBranchBeforeEnqueue` and keeps the #5057 refusal;
the other two call `assignCardNumbers` and never the branch numbering; the merge_group rule passes a ledgered
x-card and refuses an unledgered one and an unreadable ledger; an invalid mode value is ignored and logged.

## Proof plan

Live, on the next real PR that carries a new card. Before the flip: the drain log shows the queue-numbering
commit and a second CI run on a new head. After: `gh pr view <N> --json commits` shows no drain commit, the
merged head equals the judged head, the ledger has the row, and the daemon log shows
`policy-cascade · backlog.cardNumbering: mode=rename-after-land (standard)`. Then set the override back to
`rename-before-enqueue` on one pass and show the branch numbering runs again. Record the CI wall times.

## Done when

- Three consecutive real PRs with new cards land at their judged head with one CI round each.
- Flipping the setting back to `rename-before-enqueue` restores today's behaviour with no code change.

## Acceptance

- [A1] **Executable** — the per-mode tests fail before this lands and pass after
  (`npm run test:unit -- we:scripts/lib/__tests__/queue-branch-numbering.test.mjs`).

## Non-goals

- [N1] Deleting any numbering code path. Every mode stays runnable.
