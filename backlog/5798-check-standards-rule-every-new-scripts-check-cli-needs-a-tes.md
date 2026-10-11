---
bornAs: xcd73ay
kind: story
size: 2
status: open
scope: ["we:scripts/check-standards.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# check-standards rule: every new scripts check CLI needs a test file

PR 4708 review: we:scripts/merge-gate-check.mjs shipped with the fail-closed and from-main guarantees untested because only the pure evaluator had tests. Add a check:standards rule requiring a test file that imports each new scripts/*-check.mjs CLI (exercising its fact gatherer with an injected exec), so this class is caught at filing time. Rule lives with the other check:standards rules in we:scripts/check-standards.mjs.

## Acceptance

- [A1] **Executable** — `npm run check:standards` fails on a tree with a new `scripts/*-check.mjs` and no test importing it, and passes once one exists.

## Non-goals

- [N1] Does not judge test quality, and does not apply to check CLIs that already exist on main.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: matches file paths in the repo only.
2. **Truncated reads** — n/a: reads the file list and test sources already loaded by the standards run.
3. **Shared state files** — n/a: no state files.
4. **Fail closed** — an unreadable test file counts as no test.
5. **Identity scoping** — n/a: no identity involved.
6. **State over time** — a grandfather list names the existing CLIs so only new ones are caught.
7. **Who wrote it** — n/a: applies the same to every author.
