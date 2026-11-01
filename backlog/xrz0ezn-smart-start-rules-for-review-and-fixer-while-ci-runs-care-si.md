---
kind: decision
size: 5
parent: "5467"
status: resolved
scope: ["we:scripts/lib/review-timing.mjs", "we:scripts/lib/review-timing-settings.mjs", "we:scripts/operations/fix-run.mjs"]
dateOpened: "2026-11-01"
dateResolved: "2026-11-01"
codifiedIn: "docs/agent/platform-decisions.md#review-fixer-early-start-rules"
preparedDate: "2026-11-01"
preparedAgainstSha: "174220fad20252329d315759de9702bbcc698979"
tags: []
---

# Smart start-rules for review and fixer while CI runs: care, size, kinds, cancel, shadow-first

Operator ask (2026-11-01 17:39 ET): "For fixer and review we considered starting during ci, all with settings and smart rules." Start the review (and the fixer, on findings) while CI is still running, behind settings, instead of waiting for CI green.

## What already exists (do not rebuild)

Found by capability search. The base is shipped and live; only the smart rules are missing.

- #7503 (story, bornAs xw237s5, PR #6085): `review.startBeforeCi` and `fix.pushAfterCi` + `fix.pushAfterCiMaxMin`, default off, cascade-backed. Review and red team may start while CI runs when a green local verify record exists for the exact head sha (`reviewStartGate`, we:scripts/lib/review-timing.mjs:64). Ruling R241 (2026-10-29 21:14 ET) turned both on for the review and fix-dispatch daemons by env.
- `review.cancelOnCiRed` (default off, operator 2026-10-16 "keep the option, don't use it yet"): we:scripts/lib/review-timing.mjs:9,80; used at we:scripts/operations/review-pr-io.mjs:984-993.
- `review.startAfter` (fast-checks | ci-green | push) and `fix.joinCiAndReview` (we:scripts/lib/review-timing.mjs:35,90) already fold CI findings and review findings into one fix round.
- `review.speculativeRedTeam` (card xbizuci, R240) already starts the red team beside the review seats.
- #5734 (resolved): fixer pushes before its local gate. #4177 (resolved): head currency / review-hold on unknown head.

Not covered anywhere: an eligibility rule by care level, diff size or kind; a rule for what the in-flight review does when CI later goes red; the fixer starting on confirmed findings before CI ends; a shadow-first rollout with an end rule for those rules.

## Settled (ruled by precedent or forced invariant, not forks)

1. **Merge invariant.** Never merge before CI is green. Early start moves review and fix earlier, never the merge gate. A head change always voids an in-flight review and any early fix, because acceptance is keyed to the head sha (#2884; `reviewMustVoid`, we:scripts/lib/review-timing.mjs:79). The alternative breaks merge safety.
2. **A started review whose CI later goes red keeps its findings** and joins them with the CI findings into one fix round (`joinedFixDecision`, we:scripts/lib/review-timing.mjs:90, which lives in the review-timing module, not fix-run). Cancel-on-red stays off (operator 2026-10-16: "keep the option, don't use it yet"). Per-care-level cancel is out of scope until a consumer asks. A red caused by main does not count as a round (#7503).
3. **Fail closed.** Missing or unreadable care, size, kind, verify record or CI state means wait for CI. Which kinds are eligible is a default of the kind-limit setting in item 4: code kinds only; docs, config and data diffs wait for CI.
4. **Eligibility is a setting with limits, not a hard-coded rule.** Care band, diff size and kind limits are cascade settings values (policy cascade, standard < platform < repo < env). The default eligible band is `none` or `low` only, per statute #4118 (machine action only at band low). Care must be computed from the diff at start time, not read from the ready-PR escalation scorer (`deriveCareLevel`, we:scripts/lib/review-escalation.mjs:386, which nothing in review-timing consumes yet); the size cap overlaps the care `size` signal and is kept only as a cheap pre-filter. Config dimension per `#config-extends-platform-default`: the most-permissive platform flavor is the verify-record-only behavior shipped in #7503, which stays the cascade's standard value until the shadow evidence is in.
5. **Rollout is shadow first with an end rule** (precedent #4998, #2838): log "would have started early / would have waited" beside the real decision, then flip when the wasted-start rate is at or below a settings value (default values: 10%, 7 days, 30 PRs), whichever comes first. The flip is a human settings change. Lives in the build slice's acceptance.

## Fork 1 - When the fixer may start

Fork-existence: the fixer either starts before the head's CI has finished or after; pushing early restarts CI and resets acceptance, so the two are not interchangeable.

- (a) After CI completes.
- (b) **Start on confirmed findings while CI runs; hold the push until the previous head's CI is complete, then fold CI findings into the same push.** Confirmed = red-team confirmed, or at least two review seats agree (a default of a settings value), each naming the exact head sha. Unconfirmed single-seat findings never start the fixer early. At the hold bound, push only if the previous head's CI is complete; otherwise keep holding and escalate. Never push into a running CI.
- (c) Start and push at once. Excluded: it restarts CI mid-run and wastes the run it interrupts.

**Default: (b).** Behind a default-off setting, shadow first (settled item 5).
Skeptic: SURVIVES-WITH-AMENDMENT - the skeptic found "confirmed" undefined and the hold bound able to push into a running CI; both amendments (definition above, push only when previous CI complete) are folded in.
Screen: clear

## Pre-mortem

It is three weeks later and the change was a mistake. Most likely stories:
1. A started review burned a full panel on a head whose CI then failed on a missing generated file, and the redo doubled panel cost. Guard: settled item 4 limits and item 5 shadow measure wasted starts.
2. The early fixer pushed while CI of the prior head still ran and reset acceptance in a loop. Guard: push hold until previous head CI completes, never pushing while the previous head CI still runs.
3. A stale verify record for an older sha let a review start on the wrong head. Guard: record must name the exact head sha; a head move voids.
4. Someone read "early" as permission to merge early. Guard: merge gate untouched; test that proves merge refuses with CI pending.

## Acceptance

- [A1] **Executable** - vitest over we:scripts/lib/__tests__/review-timing.test.mjs and we:scripts/lib/__tests__/review-timing-settings.test.mjs fails before and passes after the build slice (new eligibility, shadow and startOnConfirmed cases). Decision turn only rules; build is a child slice.
- [A2] **Must** - every new setting defaults off and resolves through the policy cascade; shadow logs the decision without acting.
- [A3] **Must** - on error, missing or unreadable evidence, the gate refuses (waits for CI); docs, config and data diffs wait for CI.
- [A4] **Must** - merge never happens before CI is green; a test proves it with CI pending.

## Non-goals

- [N1] No change to the merge gate or to required checks.
- [N2] No new daemon; no change to the settings when off.

## Edge cases this change must handle

1. **Untrusted text** - n/a: inputs are typed settings, check states and diff counts, no free text parsed.
2. **Truncated reads** - an unreadable or partial check list counts as "CI state unknown" and the review waits.
3. **Shared state files** - verify ledger is read-only here; a torn record counts as absent. Shadow log is append-only and bounded.
4. **Fail closed** - any missing input (care, size, kind, verify record, CI state) means wait for CI; the fixer push hold ends at the bound and pushes, so a fix is never stranded.
5. **Identity scoping** - the verify record and the confirmed findings must both name the exact head sha.
6. **State over time** - a head move voids early-started review and early-started fixer; the push-hold timer is measured from first held time and is not reset by polls.
7. **Who wrote it** - findings count as confirmed only when written by the review or red-team seats of this head; a gate-less or skipped ledger record is not trusted.

## Trust boundary and threat model

Nothing new is trusted: the early start reads the same verify ledger and check states the daemons already read, and acts only on records naming the exact head sha. Threat: a PR author who controls the diff forges a small, low-care shape to get an early start. Effect is bounded to earlier review; merge still needs green CI and the full review verdict. Care level comes from the existing derivation, not author text.

## Ratified — 2026-11-01 (R359)

Operator chalbert, 2026-11-01 17:46 ET, verbatim: "Ratify xrz0ezn".

Fork 1 ruled at the bold default **(b)**: the fixer starts on confirmed findings while CI runs, holds the push until the previous head's CI is complete, then folds CI findings into the same push. It never pushes into a running CI. Confirmed = red-team confirmed, or at least two review seats agree, each naming the exact head sha.

Settled list ratified with it:
1. Merge never happens before CI is green; a head change voids any early review or fix.
2. A started review keeps its findings when CI goes red and joins them into one fix round; cancel-on-red stays off.
3. Fail closed: missing or unreadable care, size, kind, verify record or CI state means wait for CI; docs, config and data diffs wait.
4. Eligibility is a cascade setting with care, size and kind limits; default eligible care band is `none` or `low`.
5. Shadow first with an end rule (10% wasted-start rate, 7 days, 30 PRs, whichever first); the flip is a human settings change.

Codified in we:docs/agent/platform-decisions.md#review-fixer-early-start-rules. Build stories filed under parent #5467.
