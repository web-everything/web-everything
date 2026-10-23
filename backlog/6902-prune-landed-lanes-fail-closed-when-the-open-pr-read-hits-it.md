---
bornAs: xp1e7k6
kind: story
size: 2
status: open
scaffoldedBy: "fix-5530"
dateScaffolded: "2026-10-21"
scope: ["we:scripts/prune-landed-lanes.mjs"]
dateOpened: "2026-10-21"
tags: []
---

# prune-landed-lanes: fail closed when the open-PR read hits its --limit 200 cap

The prune keeps any lane branch an open PR targets (or heads), but its open-PR read uses `gh pr list --limit 200` with no truncation check. With more than 200 open PRs, a branch an open stacked PR targets can be missed and deleted. GitHub then closes that PR and refuses both a retarget and a reopen (#2578). Found while repairing web-everything/web-everything#5530 (stacked-PR policy slice 4, 6901).

## Acceptance

- [A1] **Executable** — `npm run test:unit -- we:scripts/__tests__/prune-landed-lanes.test.mjs` fails before and passes after. Named tests:
  - `open-PR read: a listing that returns exactly the limit is treated as truncated and every delete that pass is withheld`.
  - `open-PR read: a listing below the limit keeps today's behaviour (a branch no open PR heads or targets is deleted)`.
  - `open-PR read: a failed listing withholds every delete that pass` (today's fail-closed path, pinned).
  - `open-PR read: a complete initial listing followed by a capped pre-delete re-read performs no ref delete` (the initial listing is below the limit and permits a candidate; the pre-delete re-read returns exactly the cap, potentially omitting a newly protected branch; assert zero ref-deletion calls).
  - `open-PR read: a complete initial listing followed by a failed pre-delete re-read performs no ref delete` (assert zero ref-deletion calls, independently of the initial-read failure fixture).

## Non-goals

- [N1] Does not change which branches count as landed (the content check) or the near-miss comment.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: the read uses PR numbers and ref names from the API, not PR text.
2. **Truncated reads** — a listing at the limit is truncated: withhold every delete that pass.
3. **Shared state files** — n/a: adds no file; the only write stays the ref delete.
4. **Fail closed** — a truncated or failed read deletes nothing.
5. **Identity scoping** — n/a: unchanged; the read stays scoped to the repo being pruned.
6. **State over time** — the pre-delete re-read is checked the same way as the sweep-start read.
7. **Who wrote it** — n/a: no comment or label is read.
