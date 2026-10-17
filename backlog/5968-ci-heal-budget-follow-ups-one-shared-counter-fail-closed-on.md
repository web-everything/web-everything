---
bornAs: xwfvby0
kind: story
size: 3
status: resolved
scope: ["we:scripts/conveyor/ci-heal-mark.mjs", "we:scripts/conveyor/reconcile-core.mjs", "we:scripts/conveyor/tick-core.mjs", "we:scripts/operations/land-advance-io.mjs", "we:scripts/conveyor/__tests__/ci-heal-mark.test.mjs", "we:scripts/conveyor/__tests__/ci-heal-attempts.test.mjs", "we:scripts/conveyor/__tests__/reconcile-core.test.mjs", "we:scripts/conveyor/__tests__/tick-core.test.mjs", "we:scripts/operations/__tests__/land-advance-io.test.mjs"]
dateOpened: "2026-10-12"
dateStarted: "2026-10-15"
dateResolved: "2026-10-15"
preparedDate: "2026-10-15"
preparedAgainstSha: "13d85ca44eb6833d6325a9ff31f7438f8f419d9b"
tags: []
---

# CI-heal budget follow-ups: one shared counter, fail closed on bad timestamps

Apply the existing fix-head reset rule consistently across reconcile, tick and landing repair evidence, without refunding attempts whose timestamps cannot be established. Preserve attributed-main refunds, CodeQL accounting and the ordinary fix-round cap.

## Progress

- Earlier premise: tick and landing counted every heal. Current evidence: all three already use `countChargeableCiHealComments` in we:scripts/conveyor/ci-heal-mark.mjs:149, which supports attributed-main refunds and optional reason filtering. Tick calls it at we:scripts/conveyor/tick-core.mjs:2162; landing calls it at we:scripts/operations/land-advance-io.mjs:152. Only reconcile applies a fix-head reset first, at we:scripts/conveyor/reconcile-core.mjs:2034. The goal is still outstanding.
- Correct stale reset citations: recognition is at we:scripts/conveyor/reconcile-core.mjs:530, filtering at we:scripts/conveyor/reconcile-core.mjs:554, and integration at we:scripts/conveyor/reconcile-core.mjs:2034 (previously cited as lines 521, 552 and 1981). The filter retains a heal only when its timestamp compares greater than the cutoff, so an absent/invalid timestamp is dropped. Attributed-window filtering at we:scripts/conveyor/ci-heal-mark.mjs:157 already retains invalid dates.
- Correct the earlier overlay premise: we:scripts/conveyor/tick-core.mjs:896 subtracts durable refunds from a gross in-session tally, then we:scripts/conveyor/tick-core.mjs:906 stores the new tally with refunds added back. Existing repeat-refund coverage is we:scripts/conveyor/__tests__/tick-core.test.mjs:2289. A new reset-identity state machine is unnecessary for durable refunds; extend this existing gross-count invariant. Volatile attempts without dated durable evidence remain charged, even across a proven reset.
- Scope remains four source files plus five existing matching test files. Reset and cascade tests exist at we:scripts/conveyor/__tests__/ci-heal-attempts.test.mjs:59 and we:scripts/conveyor/__tests__/ci-heal-attempts.test.mjs:128; attributed-window tests at we:scripts/conveyor/__tests__/ci-heal-mark.test.mjs:589; landing's injected evidence harness at we:scripts/operations/__tests__/land-advance-io.test.mjs:18. No missing test file needs inventing.
- Retain current size 3 (the prior preparation raised it from 2). Estimate: shared module ~90 changed lines for moved policy/reset helpers and evidence composition; reconcile ~80 for removal/re-exports and two budget branches (we:scripts/conveyor/reconcile-core.mjs:2777 and we:scripts/conveyor/reconcile-core.mjs:3124); tick ~35 and landing ~35 for evidence wiring; five test files ~30–50 lines each. This is a story, so no `estimatedLoc` is added. These are implementation estimates, not measured edits.
- Built 2026-10-15: `ciHealBudgetEvidence` (we:scripts/conveyor/ci-heal-mark.mjs) now owns the budget policy, reset recognition and the stage-difference refund count; reconcile re-exports the moved names; tick (via `ciHealFloorFromComments`) and landing read it. The line citations in the earlier bullets above describe the pre-change tree: the reconcile budget branches now sit at about we:scripts/conveyor/reconcile-core.mjs:2694 and :3042 and the reset helpers live in the shared module. A heal with an unreadable time stays charged (the old filter refunded it). Follow-up: we:scripts/conveyor/exhausted-retry.mjs keeps its own copy of the reset filter and still refunds undated heals; it was outside this card's scope.
- Preparation used source inspection; implementation replays remain required below. Existing preparation stamps are left for the runner to refresh.

## Design

Move the pure policy resolver and reset recognition into we:scripts/conveyor/ci-heal-mark.mjs. Preserve existing exports from we:scripts/conveyor/reconcile-core.mjs through compatibility re-exports, including the cap and setting constants used by the resolver. Import fix marker constants from their existing owner, we:scripts/conveyor/fix-procedure.mjs; do not create a dependency back to reconcile. Preserve the current trusted-author, session-name and changed-SHA recognition rules.

Expose one pure budget-evidence calculation taking comments plus resolved reset/restore/reason options. Return the chargeable count, reset evidence (`at`, `by`, `sha`), count removed by reset, and attributed-window refund count. Compute refunds as differences between deduplicated counts at successive stages, not by adding independently overlapping reset/window counts. Retain the existing raw and chargeable counter APIs for compatibility.

A reset removes only heal markers with a finite timestamp at or before the finite reset cutoff. Missing/invalid dates and bare-string heal markers remain charged. Invalid reset evidence yields no reset. Keep all non-heal comments so attributed-window evidence survives. Apply optional reason filtering with the existing unknown-reason-is-chargeable rule. Preserve attempt-ID deduplication and author checks.

Use this evidence in both reconcile budget branches, tick's durable comment read and landing's repair evidence. Callers resolve policy using the shared resolver and their existing inputs; allow injected resolved policy for deterministic tests. Preserve existing cap precedence (including explicit reconcile cap zero), settings defaults and caller-specific reason selection: CodeQL-only filtering belongs to the CodeQL reconcile branch, while tick and landing retain their aggregate accounting.

In tick, pass the union of proven durable reset/window refunds into the existing gross-tally arithmetic. Keep `ciHealAttempts` gross: effective attempts are the maximum of zero, gross attempts minus proven refunds, and the reset-aware durable count; after launching, store effective attempts plus refunds plus one. Do not clear the tally merely because a reset exists. This preserves unrecorded attempts conservatively and prevents repeated subtraction from a net tally. Preserve live-worker guards, queue-held launch rollback, pause behavior and terminal cleanup in we:scripts/conveyor/tick-core.mjs. Reset identity is diagnostic evidence, not a new persistent store.

## MVP

Must: share the policy/reset/evidence calculation; integrate all three readers; retain malformed-time attempts; preserve gross overlay arithmetic and existing cap/guard paths; cover the combined histories below. Land as one coherent implementation so readers do not disagree during a partial migration.

Could follow later: richer operator presentation of reset diagnostics. No new retry policy, marker format, persistence layer or dispatch mechanism is needed.

## Test plan

- Extend we:scripts/conveyor/__tests__/ci-heal-mark.test.mjs with before/equal/after reset times, missing/invalid timestamps and bare strings, invalid reset dates, duplicate attempt IDs, overlapping attributed windows and reset refunds, restore disabled independently of reset, and reason filtering with unknown reasons retained.
- Extend we:scripts/conveyor/__tests__/ci-heal-attempts.test.mjs with malformed-time histories through `planReconcile`, reset disabled, trusted/untrusted markers, unchanged SHA, missing begin/end evidence and CI-heal sessions. Keep its existing policy-cascade assertions passing through compatibility re-exports.
- Extend we:scripts/conveyor/__tests__/reconcile-core.test.mjs with explicit `ciHealCap` precedence including zero, CodeQL-path reset wiring, and alternating fixer/heal histories reaching the existing fix-round cap. Retain newer-success-over-old-failure selection coverage without changing failure-selection policy.
- Extend we:scripts/conveyor/__tests__/tick-core.test.mjs with identical durable histories and two successive polls after one reset, a launch between polls, an outstanding worker, restart using durable evidence, a missing-time heal, an unrecorded volatile attempt, overlapping refunds, and a queue-held launch whose increment is rolled back. Assert gross stored counts as well as effective exhaustion/spawn results; do not test only the helper in isolation.
- Extend we:scripts/operations/__tests__/land-advance-io.test.mjs through injected `readPrComments` and resolved policy, checking the actual returned repair evidence for the same histories and reset disabled.

Run the five scoped suites only through the host heavy-admission queue using we:scripts/readiness/heavy-admission.mjs, then run `npm run check:standards` through that queue. The preparation runner owns stamping and checks; implementation tests are not claimed as executed by this preparation.

## Proof plan

Replay an identical trusted history through the shared calculation, reconcile, tick's evidence-to-planner path and landing's injected evidence reader. With three dated heals before a trusted changed-head fix and one dated heal after it, aggregate chargeable counts must equal one. Append one undated distinct heal: all aggregate readers must report two. Repeat with reset disabled: all report five. For CodeQL, compare using identical reason options separately rather than expecting a reason-specific count to equal an aggregate count.

Run a two-poll tick replay with the same reset evidence: the first new launch raises effective spending by one and the second poll retains that charge. Add a volatile charge with no durable timestamp and prove it is not refunded. Exercise overlapping reset/window evidence to show each attempt is refunded at most once, then repeat after restart with the durable history. Record returned counts, refund diagnostics, gross tally, reset evidence and dispatch/refusal results in test assertions. Exercise the existing fix cap with alternating real fixer heads and heals. Use injected reads/effects; no live dispatch, PR mutation or operational state write is needed.

## Acceptance

All three readers honor the same proven reset and charge malformed-time attempts conservatively. No repeated refund across ticks, no lost post-reset or unrecorded volatile attempt, and no bypass of the fix-round cap or explicit caller cap. Existing attributed-main refunds and CodeQL filtering remain intact.

## Non-goals

No changes to cap values, CodeQL's separate-budget policy, author allowlists, marker formats, required-check ownership or comment-read failure policy. No new head alone resets a budget without existing trusted fixer evidence.

## Follow-ups

Richer operator diagnostics can consume the returned reset/refund evidence later without changing accounting. If replay reveals a separate failure-selection or fix-cap defect, capture the failing fixture in a separate follow-up; do not expand this change into new cap policy. No prerequisite edge change is proposed.
