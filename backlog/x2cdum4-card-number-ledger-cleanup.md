---
kind: story
size: 3
parent: "xdlnylv"
status: open
blockedBy: ["xk60q6s"]
scope: ["we:scripts/lib/queue-branch-numbering.mjs", "we:scripts/lane-drain.mjs", "we:scripts/merge-ai-prs.mjs", "we:scripts/backlog/id.mjs", "we:docs/agent/backlog-workflow.md"]
dateOpened: "2026-10-13"
tags: [backlog, drain, numbering, ledger, cleanup]
---

# Remove the card rename machinery after the ledger switch

Slice (e) of epic xdlnylv: delete the dead rename path (numberPendingHashes rename and reference rewrite, queued-hash sweep, main hash repair, the local hash ledger, reservations) and update the backlog docs.

## Design

After slice (d) has run clean for a soak (see Done when), remove:

- `prepareBranchBeforeEnqueue`, `finishBranchPreparation`, `sweepQueuedHashCards`, `probeQueuedLand`,
  `repairHashOnMain`, the reservation state and `mergeGroupHashRefusals` from
  we:scripts/lib/queue-branch-numbering.mjs, and their call sites in we:scripts/merge-ai-prs.mjs (:6204-6207,
  :6540-6541, :6767-6769).
- The rename and reference-rewrite path of `numberPendingHashes` (we:scripts/lane-drain.mjs:682) and the local
  we:.claude/skills/batch-backlog-items/id-ledger.json (`LEDGER_REL`, we:scripts/lane-drain.mjs:597). Keep any helper another caller still uses.
- The `numberCardsBeforeEnqueue` setting file.
- Update the header of we:scripts/backlog/id.mjs (the hash is now permanent, not provisional) and the JIT
  numbering section of we:docs/agent/backlog-workflow.md.

## MVP

Remove the call sites and the setting; delete code with zero remaining callers.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: deletion only.
2. **Truncated reads** — n/a: deletion only.
3. **Shared state files** — the local reservation state file and the local hash ledger are left on disk, unread; no
   delete of operator state.
4. **Fail closed** — before deleting a function, `git grep` proves zero callers; any remaining caller blocks
   that deletion.
5. **Identity scoping** — n/a: no new identity logic.
6. **State over time** — any open PR still carrying an old drain numbering commit lands normally; its numeric
   file is a valid card.
7. **Who wrote it** — n/a: deletion only.

## Test plan

Delete the tests of removed functions; the full unit suite and `check:standards` stay green.

## Proof plan

Before: `git grep -n prepareBranchBeforeEnqueue` lists the call sites. After: no matches, and one real drain
pass with a new card lands it at its judged head. Paste both.

## Done when

- Slice (d) has landed at least 10 PRs with new cards and no fallback warnings.
- No code path renames a backlog file or rewrites card references at land.

## Acceptance

- [A1] **Executable** — `git grep -c prepareBranchBeforeEnqueue -- scripts/` returns nothing after this lands.

## Non-goals

- [N1] Renaming existing cards or removing `bornAs` lines.
