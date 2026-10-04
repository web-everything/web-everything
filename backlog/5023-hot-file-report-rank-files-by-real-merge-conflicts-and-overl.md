---
bornAs: xvnd841
kind: story
size: 3
parent: "3383"
status: open
scope: ["we:scripts/conveyor/", "we:scripts/operations/"]
dateOpened: "2026-10-03"
tags: []
---

# Hot-file report: rank files by real merge conflicts and overlap waits

Operator ruling 2026-10-03: split files based on data, not guesses. A JSON CLI plus a WIP-page panel ranking files by (a) merge conflicts the drain or fixers actually hit, (b) scope-overlap waits logged by we:scripts/conveyor/reconcile-fix-dispatch.mjs (e.g. waiting 2nd behind #3787 on we:docs/agent/platform-decisions.md), and (c) open PRs touching each file. Use local daemon logs and git history first, GitHub API sparingly. Done when: the CLI reports the top hot files with counts over a chosen window, and the panel shows them.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
