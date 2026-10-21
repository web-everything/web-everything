---
bornAs: xk60q6s
kind: story
size: 5
parent: "6122"
status: open
blockedBy: ["6121", "6124", "6125", "6126"]
scope: ["we:scripts/lib/queue-branch-numbering.mjs", "we:scripts/lane-drain.mjs", "we:scripts/merge-ai-prs.mjs", "we:scripts/settings/merge-queue-numbering.json", "we:scripts/settings/card-numbering.json", "we:scripts/check-standards.mjs", "we:scripts/lib/card-number-ledger.mjs", "we:scripts/lib/__tests__/queue-branch-numbering.test.mjs", "we:scripts/__tests__/lane-drain.test.mjs", "we:scripts/__tests__/merge-ai-prs.test.mjs", "we:scripts/__tests__/check-standards.test.mjs"]
dateOpened: "2026-10-13"
tags: [backlog, drain, merge-queue, numbering, ledger]
---

# Switch the card-numbering mode to rename-after-land (no code path removed)

Slice (d) of epic 6122: make every numbering step obey `backlog.cardNumbering.mode`, then flip the repo to `rename-after-land` (nightly cadence). The pre-enqueue rename is turned off for the merge queue, not deleted. The humanGate was removed on 2026-10-19: the operator approved the replacement #5057 invariant (see epic 6122, "Ruling 2026-10-19").

## Design

- Mode-gate, do not delete. Every step below stays in the code and runs only in its mode:
  Approved invariant (operator ruling 2026-10-19, point 5, epic 6122): "Every backlog card on `main` has exactly
  one number, recorded where a reader can find it: in the file name (`NNN-slug`) or in exactly one ledger row
  (`x<6>-slug`). No `x<6>` card file may be added to `main` without a ledger row, and no id or number is bound
  to two cards. A merge group that adds an unledgered `x<6>` card, or whose needed ledger is unreadable, is
  refused." The same PR amends the ratified statute `backlog-ids-numbered-before-publish` to match, and makes
  the `backlog-ids` check refuse an added `x<6>` path only when it has no ledger row.
  - `rename-before-enqueue`: `prepareBranchBeforeEnqueue` (we:scripts/lib/queue-branch-numbering.mjs:238),
    `sweepQueuedHashCards` (:318), `probeQueuedLand` (:354), `repairHashOnMain` (:200), and the
    `mergeGroupHashRefusals` merge_group refusal (:34-37, called at we:scripts/check-standards.mjs:787-789),
    with ledger-aware rollback guards: before choosing a number, every rename/repair path reads the
    ledger under `withNumberingLock`. A ledgered x-card retains its assigned number and is excluded
    from fresh-number allocation; any numeric materialization uses that existing number. Only
    unledgered cards follow today's allocation path; the ledger row records the number the rename chose.
    The merge_group refusal accepts ledgered x-cards in this mode too; unreadable or conflicting ledger
    state fails closed. These guards must ship before the flip, rather than be added during rollback.
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
- Before idempotent assignment, enforce slice (c)'s identity uniqueness on the prospective merged tree.
  A second file with an existing x-id cannot inherit its number. Assignment and merge_group use fresh,
  authenticated history from slice (a); failed fetch/history/signature checks cannot use stale success.
- Wire the guards through `numberPendingHashes` (we:scripts/lane-drain.mjs:682), including drain-direct,
  main repair and branch/queue callers. Ops-ledger assignments override the local hash map and reservations;
  new allocations exclude every ledger number. Do not defer this safety to slice (e)'s local-map retirement.

## MVP

Mode-gating, ledger-aware rollback guards on all rename/repair paths, and merge_group checks, then the flip.

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
   already on main retain their ledger numbers in every mode. On rollback, `repairHashOnMain`, branch
   numbering, queued sweeps and probes must not allocate replacement numbers for them; optional numeric
   materialization reuses the ledger number. The rename batch (slice (f)) follows the same rule.
7. **Who wrote it** — only the drain writes rows; a PR cannot add its own row because the ledger is not on the
   PR branch.

## Test plan

Unit, per mode: `rename-before-enqueue` still calls `prepareBranchBeforeEnqueue` and refuses unledgered x-cards;
the other two call `assignCardNumbers` and never the branch numbering; the merge_group rule passes a ledgered
x-card and refuses an unledgered one and an unreadable ledger; an invalid mode value is ignored and logged.
Repeat the merge_group failure cases inside the land window and for failed fetch with a stale local ref.
An integration candidate reusing a ledgered x-id in another file is refused before allocation/enqueue.

Integration rollback fixture: land ledger-numbered x-cards in both `rename-after-land` and `ledger-only`,
then select `rename-before-enqueue` through explicit repo/env overrides and lower-layer cascade resolution. Exercise
`repairHashOnMain`, `prepareBranchBeforeEnqueue`, `sweepQueuedHashCards`, `probeQueuedLand` and merge_group
checks and drain-direct `numberPendingHashes` with those existing cards plus one new unledgered card.
Include a stale local-map assignment and reservation that disagree with an existing ops-ledger row.
Assert existing id-to-number mappings and
ledger rows are unchanged, no fresh number is allocated for an existing id, any numeric rename uses its
ledger number, and only the new card receives a fresh number. Repeat after a recovery/retry and with
unreadable or conflicting ledger state (no rename, allocation or merge).

## Proof plan

Live, on the next real PR that carries a new card. Before the flip: the drain log shows the queue-numbering
commit and a second CI run on a new head. After: `gh pr view <N> --json commits` shows no drain commit, the
merged head equals the judged head, the ledger has the row, and the daemon log shows
`policy-cascade · backlog.cardNumbering: mode=rename-after-land (standard)`. Then set the override back to
`rename-before-enqueue` on one pass and show branch numbering runs for a new unledgered card while a
ledger-numbered x-card already on main keeps its number through repair and queue processing. Record the
before/after ledger rows, filenames and CI wall times.
After the flip and once real x-id cards have landed, run slice (f)'s rename batch live (it only proved
itself on a fixture, since it lands before this slice): before, `git ls-tree origin/main backlog/ | grep '/x'`
lists them; the job opens one PR; after it lands through the merge queue the same command lists none of them
and each renamed card shows its ledger number and `bornAs`. Paste both listings and the PR's CI run count.

## Done when

- The epic's recorded operator ruling of 2026-10-19 (point 5) is the approval for the exact #5057 replacement
  invariant; the humanGate is cleared by that ruling.
- Three consecutive real PRs with new cards land at their judged head with one CI round each.
- The first real rename batch PR (slice (f)) lands through the merge queue with a single CI run, and a second
  run with no new x-id cards on main opens nothing.
- Flipping the setting back to `rename-before-enqueue` restores pre-enqueue numbering for new unledgered
  cards with no additional code change; already ledger-numbered cards keep their numbers through all
  repair, queue and merge_group paths, as proved by the rollback integration fixture.

## Acceptance

- [A1] **Executable** — the per-mode tests fail before this lands and pass after
  (`npm run test:unit -- we:scripts/lib/__tests__/queue-branch-numbering.test.mjs`).

## Non-goals

- [N1] Deleting any numbering code path. Every mode stays runnable.
