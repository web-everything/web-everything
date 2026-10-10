---
bornAs: xmc5wxk
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/reconcile-core.mjs", "we:scripts/conveyor/stand-down-answer.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# A prepare PR whose card is already resolved on main closes itself as superseded

Held item 195 (session 2026-10-10). Live: #4734 (prepare #5470) sat stood-down until the operator closed it; main had built and resolved #5470 with a different design. Fix idea: the fixer or drain detects "card resolved on main => open prepare PR superseded" and uses `stand-down-answer --disposition=close-superseded` automatically, with a note.

## Acceptance

- [A1] **Executable** — a test with an open prepare PR whose card is `resolved` on origin/main closes it as superseded with a note; a prepare PR whose card is still open is untouched.
- [A2] **Live** — the next such PR closes itself with the note, no operator action.

## Non-goals

- [N1] Closing build PRs (only prepare PRs).

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: only the card id from the PR branch/title pattern is parsed, validated against the backlog.
2. **Truncated reads** — If the card or main cannot be read, do nothing (no close).
3. **Shared state files** — n/a: no shared state file; the close goes through the existing stand-down-answer writer.
4. **Fail closed** — Any doubt (card not found, status not `resolved`) -> leave the PR open.
5. **Identity scoping** — Card id is matched per repo.
6. **State over time** — Re-read the card status on current origin/main at decision time.
7. **Who wrote it** — Only prepare PRs authored by the conveyor are auto-closed.
