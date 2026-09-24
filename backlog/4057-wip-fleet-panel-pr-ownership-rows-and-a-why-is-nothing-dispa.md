---
bornAs: xqjl5lf
kind: story
size: 3
parent: "3383"
status: open
locus: plateau-app
blockedBy: ["4056", "4051"]
scope: ["plateau:src/wip/types.ts", "plateau:src/wip/wip-model.ts", "plateau:src/wip/wip-view.ts", "plateau:src/wip/wip-read.ts"]
dateOpened: "2026-09-24"
tags: []
---

# /wip Fleet panel: PR ownership rows and a why-is-nothing-dispatching answer, fed by the pr-ownership read and dispatch-eligibility

The plateau /wip page gains a Fleet panel. Part 1: one row per open PR from the pr-ownership read (PR, phase, owning daemon, bound session and transcript age, lane, time in state); rows flagged stale-binding, orphan or owed-not-dispatched sort first and move to Needs you. Part 2: when the queue has work but nothing dispatched for N ticks, one line naming the hold reason from the dispatch-eligibility operation (build side) and the reconcile dry-run refusals (PR side). Part 3: every daemon chip shows its running revision and how many commits it is behind origin/main (from #4051). Locus plateau-app.

## Why (2026-09-24 incident review)

The operator asked for "a live daemon status page: per PR, its state, which daemon owns it, time in state, session and lane". /wip already shows four daemon liveness chips and, through epic #3931, will show what each agent is doing per card. Neither answers the PR-side question that cost the most time on 2026-09-24: which PR is stuck, who is supposed to move it, and is that owner alive. Every one of these was found by hand that day: a PR frozen behind a stuck bound session (#3951 shape), a stacked PR no daemon owned (#4030), a daemon quietly running code 9 commits behind main after its smoke gate rejected an update (#4038), and owed work not dispatched while every lane was held.

Relation: #3931 is the per-card agent view (what the agent is doing). This is the per-PR ownership view (who should act next). Both live on /wip; they share the agent join of #3932.

## Done when

1. **Executable** — `npx vitest run src/wip` in plateau-app renders the Fleet panel from fixtures: a normal row, a stale-binding row, an orphan row and an owed-not-dispatched row (the three flagged rows sort first and group into Needs you); a "nothing dispatching" line with a hold reason; a daemon chip showing "N behind".
2. **Live** — with the laptop publisher running, /wip on a phone lists every open PR the reconcile dry-run lists, and each daemon chip shows the same revision `runner-activity` reports.
