---
kind: story
size: 2
status: open
scope: ["we:.github/workflows/ci.yml"]
dateOpened: "2026-10-17"
tags: []
---

# we: CI artifact uploads never fail a merge-group run

Live 2026-10-17: merge-group run 39080606823 (PR 5528) failed with all 9868 tests passing; the coverage-shard-1 upload-artifact step timed out on CreateArtifact after 5 tries under runner load. That cancelled 2 stacked groups, cost ~60-80 runner-min, and kept 5528 in the queue 63 min. Fix: the coverage-shard-N and timing-unit-N uploads get continue-on-error or a retry wrapper; a missing coverage artifact is reported, never fatal. Workflow-file edit: human-only review.

## Acceptance

- [A1] **Executable** — a workflow-lint test that parses `we:.github/workflows/ci.yml` and asserts every `coverage-shard-N` and `timing-unit-N` upload-artifact step has `continue-on-error: true` (or a retry wrapper). It fails on the current file and passes after the human-reviewed edit lands.

## Non-goals

- [N1] Changing any other CI step, the test suite itself, or the merge-group queue logic. The workflow-file edit is human-only review and is not part of this card.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: no external input; the workflow file is repo-owned.
2. **Truncated reads** — n/a: the lint test reads one whole YAML file.
3. **Shared state files** — n/a: no shared state written.
4. **Fail closed** — a missing coverage artifact is reported as a warning, never a run failure.
5. **Identity scoping** — n/a: no identity or permission change.
6. **State over time** — n/a: stateless edit to a workflow file.
7. **Who wrote it** — n/a: author is the repo owner through the normal PR review.
