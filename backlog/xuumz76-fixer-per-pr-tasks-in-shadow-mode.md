---
kind: story
size: 3
parent: "xz2yynk"
status: open
blockedBy: ["xs4ewgh"]
scope: ["we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs", "we:scripts/conveyor/fix-pr-task.mjs", "we:scripts/conveyor/reconcile-fix-dispatch.mjs", "we:scripts/operations/ci-heal-pr-dispatch.mjs", "we:scripts/operations/promote-draft-pr-dispatch.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# Fixer per-PR tasks in shadow mode

Slice S3 of the async-daemons epic; blocked by S1 (x7cvrkd -- not on main yet, built in lane-17, so the edge is in this text until it lands -- item 200: item 200: one shared gh read set per pass, per-PR planner `planPrForRoles`, budget report = go/no-go for this slice) and S2a. Today `runTickAllRepos` (we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs:664-800) runs fix, ci-heal, promote-draft and notes as separate `runReconcilePass` per repo, planning every PR 4x. Add one `fix-pr` task per PR across all roles (E1, O2) in new we:scripts/conveyor/fix-pr-task.mjs. Setting `daemonTasks.fixer.mode: inline|shadow|tasks` (cascade), default `inline`. In shadow, tasks plan only and journal any diff against the inline plan. Shadow tasks hold no claim and act on nothing.

## Acceptance

- [A1] **Test (a)** — shadow mode makes zero `gh` writes and zero spawns; the writes are recorded and asserted empty.
- [A2] **Live** — 0 action diffs over 5 live ticks, and per-task `gh=` within the S1 budget.

## Non-goals

- [N1] Acting from tasks (that is S3t).
- [N2] Removing the inline path (S3t).

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: PR text is only read as facts through the recording accessor; nothing is written.
2. **Truncated reads** — A stale or missing snapshot schedules nothing that tick (`deferred-read`).
3. **Shared state files** — Shadow journals are append-only per task; no shared claim or lock is taken.
4. **Fail closed** — Any shadow error is logged and never affects the inline path.
5. **Identity scoping** — Tasks are keyed by `(fix-pr, repo, PR)`.
6. **State over time** — Diffs are compared on the same snapshot the inline pass used, so time skew is not a diff.
7. **Who wrote it** — n/a: shadow tasks write nothing other daemons read.
