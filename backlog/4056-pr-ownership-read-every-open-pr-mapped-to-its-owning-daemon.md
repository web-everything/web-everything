---
bornAs: xee72b2
kind: story
size: 3
parent: "3383"
status: open
scope: ["we:scripts/operations/pr-ownership.mjs", "we:scripts/operations/pr-ownership-io.mjs", "we:scripts/conveyor/reconcile-core.mjs"]
dateOpened: "2026-09-24"
relatedReport: reports/2026-09-24-plateau-observability-review.md
tags: []
---

# pr-ownership read: every open PR mapped to its owning daemon, next move, bound session and its transcript age, lane, and time in state

One read-only declared operation that answers 'who owns this PR right now and is that owner alive'. For every open PR in each constellation repo: phase (from the reconcile dry-run), the daemon that owns the next move (review, fix-dispatch, drain, dispatcher, or none), the session bound to it by bindAgents plus that session's transcript age, the lane lease, and how long the PR has sat in its current phase. Flags three shapes seen live on 2026-09-24: a stale binding (bound session with an old transcript freezes the PR, #3951), an orphan (no daemon owns the next move, e.g. a stacked PR whose base is not main), and owed-but-not-dispatched past N ticks.

## What to reuse (do not re-derive)

- Phase and refusal reason per PR: `runReconcilePass` in dry-run mode (we:scripts/conveyor/reconcile-pass.mjs), the same call the #4038 smoke gate already makes.
- Session binding: `bindAgents` in we:scripts/conveyor/reconcile-core.mjs. Add the bound session's transcript mtime age as a field. Do not change how binding decides.
- Lane: the lane lease files, as `stale-state` already reads them.
- Daemon liveness: `runner-activity`. Owner mapping is a fixed table from phase to daemon: needs review → review daemon; changes or conflict → fix-dispatch daemon; ready-to-merge → drain; base not main → fix-dispatch stacked-rebase (#4030); anything else → none (orphan).
- Card join: the PR→card map #3932 already needs. Share it; do not build a second one.

## Flags (pure function, thresholds in one config block)

- `stale-binding`: bound session's transcript untouched for more than 20 minutes while the PR is owed.
- `orphan`: owner is none, or the owner daemon is `down`/`dead` in runner-activity.
- `owed-not-dispatched`: owed for more than N reconcile ticks with no dispatch record.

## Done when

1. **Executable** — `npx vitest run we:scripts/operations/__tests__/pr-ownership.test.mjs` passes with one fixture per shape: owned and healthy, stale binding (a `blocked` session whose transcript is 3 hours old, the #3951 live shape), orphan stacked PR (base not main, the #4030 shape), owner daemon down, and owed-not-dispatched. Fails before this lands (the operation does not exist).
2. **Live** — `node we:scripts/operations/run.mjs pr-ownership --json > <file>` on the laptop lists every open PR the reconcile dry-run lists across the constellation repos, each with an owner or a flag.
