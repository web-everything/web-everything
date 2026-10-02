---
bornAs: xzv8r3e
kind: story
size: 2
status: open
scope: ["we:scripts/progress-board.mjs", "we:scripts/__tests__/progress-board.test.mjs", "we:scripts/conveyor/reconcile-core.mjs", "we:scripts/conveyor/reconcile-pass.mjs", "we:scripts/conveyor/__tests__/reconcile-core.test.mjs", "we:scripts/conveyor/__tests__/reconcile-pass.test.mjs"]
dateOpened: "2026-09-30"
preparedDate: "2026-10-02"
preparedAgainstSha: "3f130ea59e0ffd5524322915a70a1866235d32ec"
tags: []
---

# Pin why a conflicting PR can read `queued` in `classifyPr`

Diagnosis: `we:reports/2026-09-30-conflicting-prs-nobody-owns.md`. Preserve the goal: explain how a conflicting PR can read `queued`, prevent a supplied positive conflict signal from silently becoming `queued`, and make subsequent `nothing-owed` refusals identify the merge inputs actually observed. The report does not preserve the contemporaneous inputs for #3176/#3215; do not claim that a synthetic reproduction establishes their historical cause.

## Done when

1. **Executable** — `we:scripts/__tests__/progress-board.test.mjs` feeds `classifyPr` a `review:accepted` PR with `mergeStateStatus: 'UNKNOWN'` and `mergeable: 'CONFLICTING'` and asserts `conflicted`. This regression fails before implementation and passes after.
2. **Executable** — `we:scripts/conveyor/__tests__/reconcile-core.test.mjs` proves that reconciliation forwards this conflict signal and that a remaining `nothing-owed` refusal's `why` text names both observed fields, including explicit missing-value markers.
3. **Executable** — discovery tests prove both production PR queries request `mergeable`; fixture-only classifier coverage is insufficient.

## Progress

- Original premise/scope: `classifyPr` already checked `DIRTY`/`BEHIND` before acceptance, leaving stale/unknown/disagreeing merge inputs as candidates for #3176/#3215. Scope named only `we:scripts/progress-board.mjs` and `we:scripts/conveyor/reconcile-core.mjs`, without matching test paths.
- Corrected premise: the conflict check still exists at `we:scripts/progress-board.mjs:603`, but `classifyPr` never reads `mergeable`. The board query omits it at `we:scripts/progress-board.mjs:443`; the reconcile query also omits it at `we:scripts/conveyor/reconcile-pass.mjs:132`; and the classifier projection drops it at `we:scripts/conveyor/reconcile-core.mjs:1591`. Thus adding a classifier branch alone cannot fix production reads. The refusal at `we:scripts/conveyor/reconcile-core.mjs:2110` exposes neither field.
- Observed preparation probe: importing the current classifier and passing an open, accepted PR with an empty rollup, `UNKNOWN` merge state and `CONFLICTING` mergeability returned `queued`. This establishes the present code defect, not the historical payload of either PR. The goal is not already delivered.
- Corrected scope: add `we:scripts/conveyor/reconcile-pass.mjs` for acquisition; pair the board source with existing `we:scripts/__tests__/progress-board.test.mjs`, and both reconciliation sources with existing `we:scripts/conveyor/__tests__/reconcile-core.test.mjs`, which already imports and tests `defaultReadPrs` and its query fields. No source implementation is changed during preparation.
- Test-scope repair: the prior scope paired both reconciliation sources only with `we:scripts/conveyor/__tests__/reconcile-core.test.mjs`. Add the existing matching `we:scripts/conveyor/__tests__/reconcile-pass.test.mjs` for `we:scripts/conveyor/reconcile-pass.mjs`: its `prFileContract` invocation at line 17 pins the discovery field list at line 20, which must also gain `mergeable`. This expands test coverage scope without changing the implementation goal.
- Existing ownership evidence: `we:scripts/conveyor/parked-pr-conflict-watch.mjs#isQueuedConflictTarget` already recognizes positive `CONFLICTING` mergeability. `we:scripts/conveyor/reconcile-core.mjs#OWED_ELSEWHERE` already routes `conflicted` to a rebase refusal. Reusing that phase requires no new ownership policy or unknown phase. The report explicitly leaves the original incident inputs unsettled.

## Design

Extend the existing conflict predicate in `we:scripts/progress-board.mjs#classifyPr` with normalized `mergeable === 'CONFLICTING'`, at its current precedence position. Keep merged, bounced, human-held and CI-red precedence intact. Positive conflict evidence maps to the existing `conflicted` phase even when merge state is `UNKNOWN` or `CLEAN`; unknown or absent mergeability alone is not evidence of conflict. Preserve current behavior for records lacking the new field.

Request `mergeable` alongside `mergeStateStatus` in both `we:scripts/progress-board.mjs#ghPrList` and `we:scripts/conveyor/reconcile-pass.mjs#PR_LIST_JSON_FIELDS`. Forward it in `we:scripts/conveyor/reconcile-core.mjs#planReconcile`'s classifier projection. Keep the shared-read and direct-query paths using the same requested field set.

Extend the `nothing-owed` refusal's `why` in `we:scripts/conveyor/reconcile-core.mjs` with named `mergeStateStatus` and `mergeable` values from that pass's PR record, preserving raw values for diagnosis and using `<missing>` for null/undefined. Put the values in the human-readable reason, not only extra object properties: `we:scripts/conveyor/reconcile-pass.mjs:963` renders that reason. Do not refetch inside the pure planner or infer that a current response was also the historical response.

## MVP

1. Add the failing classifier, field-acquisition, forwarding and refusal-reason cases to the three scoped test files.
2. Add the query fields and projection, then extend the existing classifier predicate and refusal reason.
3. Deliver as one cohesive change with no new phase, polling loop, label mutation, grace-window change or repair-ownership change. A `conflicted` phase continues through existing reconciliation routing.

## Test plan

- In `we:scripts/__tests__/progress-board.test.mjs`, cover accepted `UNKNOWN`/`CONFLICTING` and `CLEAN`/`CONFLICTING` records, lowercase normalization, existing `DIRTY`/`BEHIND` behavior, and accepted `UNKNOWN` with absent/unknown mergeability retaining current behavior. Assert higher-priority merged, bounced, human-hold and CI-red cases remain unchanged. Extend the existing fake-CLI board tests to assert the requested JSON fields include `mergeable` and that a returned conflict appears as `conflicted`.
- In `we:scripts/conveyor/__tests__/reconcile-core.test.mjs`, extend the injected-exec discovery assertions with a literal requirement for `mergeable` (not merely equality to the exported constant). Feed the acquired record to `planReconcile` with no live session or earlier refusal: `UNKNOWN`/`CONFLICTING` must yield phase `conflicted`, `owed-elsewhere`, and no dispatch. This catches a missing projection even if the classifier test passes.
- In `we:scripts/conveyor/__tests__/reconcile-pass.test.mjs`, update the literal discovery field list passed to `prFileContract` to include `mergeable`, preserving the existing reader/pass contract checks.
- In the same reconciliation core test file, use an accepted nonconflicting record to reach `nothing-owed` and assert both named raw values in `why`; repeat with missing fields and assert `<missing>` markers. Verify the existing rendered plan output retains the reason containing both fields.
- Run the affected Vitest suites for `we:scripts/__tests__/progress-board.test.mjs`, `we:scripts/conveyor/__tests__/reconcile-core.test.mjs`, and `we:scripts/conveyor/__tests__/reconcile-pass.test.mjs`, then `npm run check:standards`. These are implementation checks; the preparation runner owns preparation checks and stamping.

## Proof plan

Record red-before/green-after output for the disagreement regression and refusal-reason regression. Demonstrate that removing the new query field or classifier projection independently breaks acquisition/forwarding coverage. Capture the rendered refusal for a deterministic queued fixture so diagnostic visibility is observed, not inferred from extra properties.

On the next naturally occurring queued/conflicting discrepancy, retain the same pass's refusal reason, PR number, head and timestamp, plus its available input snapshot. Compare those observations before naming a stale-state or disagreement cause. A fresh query of #3176/#3215 cannot reconstruct their September 30 inputs; if no contemporaneous snapshot survives, explicitly leave that historical cause unknown. No live PR mutation is required for proof.

## Follow-ups

- Use the enriched diagnostics to distinguish missing fields, `UNKNOWN`, and positive disagreement on recurrence. Any retry/cache-freshness mechanism needs evidence from that recurrence and is outside this change.
- The report's separate long-lived-session question remains separate: this item does not change liveness detection, conflict-watcher grace, or dispatch ownership.
