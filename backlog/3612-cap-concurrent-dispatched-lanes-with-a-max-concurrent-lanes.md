---
bornAs: xupukxa
kind: story
size: 5
tier: pinned
parent: "3383"
status: open
scope: ["we:scripts/readiness/dispatch-plan.mjs", "we:scripts/conveyor/tick-core.mjs", "we:scripts/lib/lane-concurrency.mjs"]
dateOpened: "2026-09-07"
tags: []
---

# Cap concurrent dispatched lanes with a MAX_CONCURRENT_LANES admission ceiling

Live incident 2026-09-07: freeing one lane cascaded into 19 builds + 23 prepare-scope agents dispatching in ONE tick (42 concurrent claude -p sessions), driving 1-min load average to 34.95 on the host. Confirmed by reading we:scripts/readiness/dispatch-plan.mjs#dispatchPlan and we:scripts/conveyor/tick-core.mjs#planTick in full: neither has any concept of a global concurrent-lane ceiling — dispatchPlan assigns a launch to every free lane in rank order (bounded only by freeLanes.length), and planTick's planPrepareSpawns/planFixSpawns/planCiHealSpawns each independently consume whatever free lanes dispatchPlan's builds did not take, with zero shared budget across the four spawn kinds. This is a DIFFERENT layer from we:scripts/readiness/heavy-admission.mjs's existing cap=2 semaphore (#3461/#3456): that caps concurrent HEAVY COMMANDS (verify-lane/check:standards) running INSIDE already-dispatched lanes; this item caps how many lanes/claude-sessions get dispatched AT ALL, upstream of heavy-admission entirely — confirmed distinct by reading we:scripts/readiness/heavy-admission.mjs's own module header (it only gates the invocation of a named heavy-command set, never lane acquisition). Also distinct from, and does not require resolving, the staged hardware-usage-aware admission decision (3610 / we:backlog/3610-how-far-to-take-heavy-command-admission-control-beyond-stage.md, filed but not yet merged in PR #1998) — that decision is specifically about whether heavy-admission's per-command cap should become EWMA-adaptive or learned; it says nothing about lane-dispatch concurrency, which today has no cap of any kind. Build a MAX_CONCURRENT_LANES ceiling: a small shared resolver (env var WE_MAX_CONCURRENT_LANES, mirroring we:scripts/readiness/heavy-admission.mjs's WE_HEAVY_ADMISSION_CAP config-knob convention, default conservative — well below tonight's 42-lane spike, e.g. 8 on the host) that (1) we:scripts/readiness/dispatch-plan.mjs#dispatchPlan trims its free-lane list against BEFORE assigning builds (using the currently-active leases count it already receives), holding the excess with a new, distinct HELD_REASONS entry (never conflated with the existing 'no free lane' reason, which means something structurally different: no free lane at all vs. free lanes existing but capacity-gated), and (2) we:scripts/conveyor/tick-core.mjs#planTick trims the availableLanes budget prepare/fix/ci-heal spawns draw from, by the SAME cap minus (already-active lanes + this tick's admitted builds), so the four spawn kinds combined can never exceed the ceiling in one tick. Not the full hardware-usage-aware/self-learning project 3611 stages toward — this is the simple, fixed, conservative floor that is correct regardless of how that fuller decision eventually resolves.

## Finding (2026-09-21): the ceiling should be a weighted budget by dispatch kind

Operator, 2026-09-21: "We need a different cap value per type of lane. A review that does not launch heavy commands takes very little capacity vs a build lane that has to run tests repeatedly." A flat count treats a review and a build as the same lane. The orchestrator has been working to a PROVISIONAL weighted budget of 6 units of live work: review or advisory review 0.25, light task (filing, docs, docket refresh, tracker publish, update-branch) 0.5, prepare (research plus one verify-lane at the end) 1.0, build or fix with repeated test runs 1.5, and capacity calibration exclusive (the whole budget, nothing else live). A dispatch is admitted while the sum of the live weights plus the new weight is at most 6. The heavy-command pool stays the structural bound on heavy work whatever the weights say. The rule and its reasoning are in the orchestrator's local notes ("DISPATCH RULE v3"), not in the repo.

- **Where it belongs.** The resolver in we:scripts/lib/lane-concurrency.mjs returns a budget rather than a count, shared by we:scripts/readiness/dispatch-plan.mjs and we:scripts/conveyor/tick-core.mjs, and by we:scripts/operations/dispatch-lane.mjs, so every dispatch path weighs a candidate by its kind.
- **Where the numbers come from.** The weights are provisional and should be set from the sampler's per-kind rollup (`host.workers.live` per kind and the `perWorker` figures in `reservation-inputs`). The first samples were thin (for example review 8.3% CPU and 1669 MB over 5 workers, build 0.5% and 1065 MB over 3, task 28.3% and 3706 MB over 8).
- **Tracking.** Re-evaluating the numbers is card 3800; this finding is the design input to the resolver.

## Finding (2026-09-21): the weights and the budget get a tracked home, card 3807

The finding above puts the weighted budget in the resolver of `we:scripts/lib/lane-concurrency.mjs` but leaves the numbers in the orchestrator's local notes. Card 3807 gives the resolver a tracked `dispatch-budget` config (budget, weight per kind, ramp steps, knee thresholds, emergency floor, and a dated reason for each change) read by `dispatch-plan`, `tick-core`, `dispatch-lane` and `dispatch-task`, so a handoff loses nothing; it extends this card and folds in #3727. Two facts to keep straight: the repo's "8" here is a lane COUNT, while rule v4's "8" is 8 units of weighted work; and `we:scripts/operations/dispatch-lane.mjs` and `we:scripts/operations/dispatch-task.mjs` still read no ceiling. Whether one weighted budget is enough, or heavy and light workers need separate counts, is the open decision 3806 (default: one budget plus the heavy pool).

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.
