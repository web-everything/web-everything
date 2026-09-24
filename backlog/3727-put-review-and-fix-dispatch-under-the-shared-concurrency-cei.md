---
bornAs: xjsj7pg
kind: story
size: 3
parent: "3718"
status: open
relatedTo: ["3612", "3438", "3720"]
scope: ["we:scripts/operations/review-dispatch.mjs", "we:scripts/conveyor/reconcile-fix-dispatch.mjs", "we:scripts/lib/lane-concurrency.mjs", "we:skills-src/conveyor/runner.mjs"]
dateOpened: "2026-09-19"
tags: []
---

# Put review and fix dispatch under the shared concurrency ceiling so re-armed PRs are dispatched staggered, not in a burst

The reconcile path dispatches one review per owed PR with no admission check. Re-arming many `review:pending` PRs at once therefore launches that many reviewers together; on 2026-09-19 the machine load reached 28 on 12 cores.

## What exists and what does not

- The ceiling exists: `we:scripts/lib/lane-concurrency.mjs` (#3612), one resolver and one trim function shared by `we:scripts/readiness/dispatch-plan.mjs` (builds) and `we:scripts/conveyor/tick-core.mjs` (prepare, fix, ci-heal). Its own header says it is a fixed count and hardware-blind by design.
- The reconcile dispatch path does not use it. In `we:skills-src/conveyor/runner.mjs` (`makeCliMechanicalPasses`) the review-reconcile pass loops over every `review` entry in the reconcile plan and calls `we:scripts/operations/review-dispatch.mjs` for each, sequentially but with no count of live sessions. `we:scripts/conveyor/reconcile-fix-dispatch.mjs` has the same shape. A search of those two files and `we:scripts/conveyor/reconcile-pass.mjs` finds no admission or ceiling reference.
- #3612 (open) is the older, broader "cap concurrent dispatched lanes" story; the resolver above is what landed from it. Before starting, check whether #3612 is now redundant with this slice and, if so, say so on both cards rather than filing a third.

## Fix shape

- `review-dispatch` and `reconcile-fix-dispatch` each read the live dispatched-session count and the ceiling from the shared resolver, dispatch at most the remaining headroom, and REPORT the overflow as `deferred: over-ceiling` (never dropped, never an error). The next call picks the overflow up, because reconcile re-derives what is owed every time. That is the stagger.
- A caller-supplied budget wins when smaller: `land-advance` (#3720) computes one budget up front and passes it down.
- Do not add a load-average gate here; that lives in `land-advance` (#3720) as its one new rule. If the operator wants load-awareness for every caller, it belongs inside `we:scripts/lib/lane-concurrency.mjs` and is a separate call, not folded in silently.

## Finding (2026-09-21): reviews and fixes should weigh less than builds under the shared ceiling

When review and fix dispatch join the shared ceiling, they should not count as one lane each. The operator's ruling (2026-09-21) is a different cap per type of lane: a review that launches no heavy commands takes very little capacity compared with a build lane that runs tests repeatedly. The provisional weights are review 0.25, light task 0.5, prepare 1.0, build 1.5 (fix runs tests repeatedly, so it weighs as a build), calibration exclusive, against a budget of 6 units; they are to be set from the sampler's per-kind rollup (see the finding on #3612). Counted as whole lanes, a burst of re-armed reviews would be throttled as hard as a burst of builds, which is the opposite of the intent. `review-dispatch` and `reconcile-fix-dispatch` should therefore read the remaining budget in units and pass their kind's weight, not a count. Tracked for re-evaluation on card 3800.

## Finding (2026-09-21): read the budget from the tracked config, card 3807

The units budget and the kind weights this card's finding asks `review-dispatch` and `reconcile-fix-dispatch` to read will live in the tracked `dispatch-budget` config of card 3807, through the one resolver in `we:scripts/lib/lane-concurrency.mjs`. Build against that resolver rather than a local constant, so the number stays in one place. Whether the count should be one weighted budget or separate heavy and light counts is the open decision 3806 (default: one weighted budget plus the heavy pool).

## Done when

1. **Executable** — `npx vitest run we:scripts/operations/__tests__/review-dispatch.test.mjs we:scripts/conveyor/__tests__/reconcile-fix-dispatch.test.mjs` carry cases that fail before and pass after: with the ceiling at 3 and 2 live sessions, ten owed reviews dispatch exactly one and report nine deferred; at the ceiling, none dispatch and none error; a smaller caller budget is honoured.
2. **Probed live** — re-arming several real `review:pending` PRs dispatches no more reviewers in one pass than the ceiling allows.

## Additions from 2026-09-24 incident review

- **The daemons are separate processes now.** Since this card was filed, review and fix dispatch moved out of the runner into their own daemons (#3876, #3870). A ceiling computed inside one process cannot see the others. The live count must come from a shared source every daemon reads (the `claude agents` listing filtered by dispatch slug, or a shared lease directory), so three daemons together still stay under one budget.
- **Stuck sessions eat the budget.** On 2026-09-23/24 the plateau-app pool sat at 14/14 held, largely by review sessions stuck `blocked` (#3951). A ceiling that counts them as live work starves new dispatch, and a ceiling that ignores them over-admits. Count a session whose transcript has not moved for longer than the stale threshold (the `transcriptAgeS` field added to #3932) separately, report it as `held-by-stale`, and let the reaper (#3721, #3624) free it. Do not silently drop it from the count.
- **Machine load (operator proposal 7).** The load-aware part is owned by #3807 (tracked budget), #3808 (capacity review) and #3611 (adaptive admission). This card only needs to read the one resolver; no second load rule here.
