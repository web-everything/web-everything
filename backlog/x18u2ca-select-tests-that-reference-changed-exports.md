---
kind: story
size: 3
status: open
scope: ["we:scripts/lib/", "we:scripts/verify-lane.mjs"]
dateOpened: "2026-11-23"
tags: [testing, prevention]
---

# Select tests that reference changed exported functions

PR #7381 review found that changing `we:scripts/merge-ai-prs.mjs#ghListErrText` affected an existing merge-failure test outside the reported test run. Require the affected-test selector to include every test file referencing an exported function whose body changed, or refuse an incomplete explicit run set.

## Acceptance

- [A1] Executable selector regression: change an exported function body with two referencing test files; both files enter the selected gate even when only one test was edited.
- [A2] Cover async functions, re-exports, aliases, deleted exports, and unrelated same-name symbols. Unreadable source or an incomplete bounded search produces an explicit selection-required result.
- [A3] Exceeding a source/search bound names the affected-test override as the operator fallback; never silently treat an incomplete search as no dependents.

## Non-goals

- Replace the import graph or run the full unit suite for every repair.

## Edge cases

- Untrusted text: parse source and pass paths as argv; do not interpolate symbols into shell commands.
- Truncated reads and resource bounds: bound source bytes and referencing-file counts, with an explicit selection-required fallback.
- Shared state: selection derives from the pinned before/after tree; no new mutable registry.
- Identity and normalization: preserve module identity for same-name exports and normalize repository-relative paths once.
- Fail closed: unknown syntax or unreadable evidence requires an explicit affected-test selection.

Source: PR #7381 correctness prevention, review dated 2026-11-23.
