---
kind: task
status: open
scope: ["we:scripts/conveyor/red-team-queue.mjs", "we:scripts/conveyor/__tests__/red-team-queue-head-move.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Red-team queue lost PR #7146 silently after a drain-rebase head move

#7146 left the red-team queue silently: dispatched 20:43 for d3db50, head moved to cea20cb8 at 20:55 (drain rebase), no queue entry since. Source: build-queue 22:45 ET 2026-11-20.

## Acceptance

- [A1] **Executable** — Planned `retains queued PR across drain-rebase head move` in `we:scripts/conveyor/__tests__/red-team-queue-head-move.test.mjs`: Replay the d3db50 to cea20cb8 head transition; assert the PR remains queued or is requeued for the new head and is never silently dropped.

Run `npm run test:unit -- <test-files>` through the host heavy-run queue using the repository-relative paths after the `we:` prefixes above. These cases are planned; this card does not claim they already pass.

## Non-goals

- [N1] No reuse of a review for the wrong head.

## Edge cases this change must handle

1. **Untrusted text** — Head and queue text remain data.
2. **Truncated reads** — Incomplete head reads retain a visible pending entry.
3. **Shared state files** — Update the queue without losing the PR during replacement.
4. **Fail closed** — An unknown head holds review with a visible reason.
5. **Identity scoping** — Bind queue entries to PR and head.
6. **State over time** — Cover an in-flight dispatch followed by a head move.
7. **Who wrote it** — Only observed current-head evidence replaces an entry.

## Duplicate admission

new-card-from-build-queue-CARD-line --json
