---
bornAs: x5zjbp4
kind: story
size: 5
parent: "3383"
status: open
scope: ["we:scripts/operations/load-review.mjs", "we:scripts/operations/load-report-cli.mjs", "we:scripts/lib/lane-concurrency.mjs", "we:scripts/readiness/heavy-admission.mjs"]
dateOpened: "2026-09-20"
tags: []
---

# Set concurrency limits from host-sampler data: dated checkpoint, weekly review, change log

GOAL (operator, 2026-09-20): set the lane cap, worker cap, heavy-command admission size and session count from measured host load, not guesses. The sampler (we:scripts/operations/host-sampler.mjs) has run since 2026-09-20 13:06 EDT and the analysis exists (we:scripts/operations/load-report-cli.mjs, we:scripts/operations/load-review.mjs with suggestLimits and resourceReviewOwed) but nothing schedules the review, nothing decides who may change a limit, and the goal lives only in a tracker note. DESIGN TO SETTLE BEFORE BUILD (strong design required; file cleared only after a design review): (1) METHOD: p90 load1 at or below the core count, probe p90 under the stated bounds (spawn 250 ms, spin 25 ms), heavy-admission size as the driver rather than lane count, at least 48 h of samples including one busy window (coverage.sufficient). (2) TRIGGER: how a review comes due without a person remembering: resourceReviewOwed must become a queued item automatically (same rule as the wip Attention change) or a scheduled routine; first checkpoint 2026-09-22 about 13:06 EDT, then weekly. (3) AUTHORITY: an agent may PROPOSE via suggestLimits; only the operator applies a change, and every change is recorded with record-limit-change. (4) ROLLBACK: after a change, the next review compares before and after; a worse saturation share or probe p90 reverts it. (5) SCOPE: which limits are in scope (we:scripts/lib/lane-concurrency.mjs, the land-advance worker cap, we:scripts/readiness/heavy-admission.mjs, session count) and who owns each. ACCEPTANCE: an executable check exits non-zero when a review is overdue; the first review is recorded; a limit change is logged with before and after numbers.

## Design review (jury, 2026-09-20, careLevel low): verdict `changes`, escalated

All seven lenses accepted but the red-team kept findings alive; the ones below were checked against the code and hold. The design above must absorb them before this card is cleared.

1. **Unit mismatch.** `suggestLimits` buckets heavy load by the count of vitest and playwright PROCESSES (edges 0, 1, 2, 3, 5) and emits `heavyAdmissionCap`, but the real cap counts admitted COMMANDS (verify, check:standards, visual capture) and one command fans out into many processes. Bucket on admission-slot occupancy (record it in the sampler) so the number has a defined mapping to the knob.
2. **Lever unproven.** The cap is already a flat 2 and last-hour p90 load1 is 19.0 (24 percent of samples above 12), so the method never shows admission is what drives the bursts. Add an attribution gate first: the share of over-core sample windows whose CPU comes from processes holding an admission slot. If it is low, name a different lever.
3. **The method cannot raise a limit.** It only considers observed buckets, buckets under 30 samples stop the climb, and a flat cap leaves buckets above it empty; samples are also treated as independent though consecutive samples in one burst are strongly autocorrelated and hot-mode 5 s sampling oversamples exactly the hot periods. Require time-weighted percentiles, a floor on independent episodes per bucket, and a time-boxed trial at cap 3.
4. **`coverage.sufficient` is too weak.** It is 48 hours of span AND ONE sample above the core count. Define a busy window as a minimum number of independent above-core episodes or contiguous minutes, and make `resourceReviewOwed` record whether the last review was confident so a weak first review does not reset the clock.
5. **Scope names what the code does not cover.** `suggestLimits` has no land-advance worker-cap dimension (only `heavyAdmissionCap`, `concurrentSessions`, `concurrentLanes`). Add the dimension and its recording path, or drop the limit from scope. Correction to one jury claim: the recording command DOES exist, as `we:scripts/operations/load-report-cli.mjs --record-limit-change` (it appends one `config.limit.changed` event and changes no limit); use that name in the design.

## Finding (2026-09-21): the first reevaluation is filed separately, with two dimensions this card does not name

Card 3800 is the first concrete reevaluation of the core budget (the system reserve, the heavy pool, the worker budget) at this card's first checkpoint, 2026-09-22 about 13:06 EDT. It adds two things to this card's scope: per-kind dispatch weights (the orchestrator now works to a provisional 6-unit budget with review 0.25, light task 0.5, prepare 1.0, build 1.5, calibration exclusive; see the finding on #3612), and a ratified formula for lanes per hardware profile rather than one constant for the host. It also records why the first 18.6 hours of samples are contaminated (orphaned `eleventy --serve` processes until 2026-09-21 and the operator's photo dedupe), so the clean window for the busy-window and coverage rules above starts after that.

## Finding (2026-09-21): the review becomes a read-only operation on the tick, card 3808; the method is the rule v4 knee signals

The operator asked (2026-09-21) to keep adjusting the budget as data arrives, with regular suggestions and a process that survives a handoff. Card 3808 is that process for the worker budget: a read-only `capacity-review` operation that reads the sampler episodes (`admission_wait_s`, `wall_s` per command family), the heavy pool waiting count and age, CPU and RAM against the emergency floor, and returns ONE of `raise`, `hold`, `lower` with the numbers, run by the runner tick rather than a session cron and shown in `/wip`. It replaces this card's p90 load1-versus-cores method with the direct signals of rule v4, keeps this card's authority rule (an agent suggests, the operator applies by a reviewed commit) and its rollback idea, and its exclusion of non-representative windows needs the `annotations.jsonl` reader that does not exist yet. The numbers it compares against come from the tracked config of card 3807. This card keeps the wider scope (lane cap, session count, heavy-pool size); reconcile the two before building either.
