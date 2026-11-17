---
bornAs: xk7pg3s
kind: story
size: 2
status: resolved
dateOpened: "2026-11-16"
dateResolved: "2026-11-17"
tags: []
---

# Stall sweep pages the PR file list past 100 files

The stall sweep reads a PR's files with `gh pr view --json files`, which returns at most 100, then throws "truncated file list". The judge step then yields a null verdict, so big PRs such as #6945 (129 files) get a false fail-closed "ruling-needed". Page the list through `gh api repos/{owner}/{repo}/pulls/{n}/files` up to GitHub's 3000-file cap, and surface a list over the cap as its own `file-list-over-cap` state, not as a null verdict.

## Acceptance

- [A1] **Executable** — `we:scripts/conveyor/__tests__/pr-stall-sweep.test.mjs` includes named tests `pages the file list past 100 files`, and `surfaces a file list over the 3000-file cap as file-list-over-cap, not a null verdict`. They fail before the fix and pass after.
- [A2] **Must** — page reads go through the existing gh-throttle wrapper; a short, unreadable or malformed page still fails closed.

```bash
npm run test:unit -- scripts/conveyor/__tests__/pr-stall-sweep.test.mjs
```

## Non-goals

- Changing `we:scripts/conveyor/pr-stall-classify.mjs`.
