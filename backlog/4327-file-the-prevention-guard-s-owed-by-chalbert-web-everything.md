---
bornAs: xkhionl
kind: story
size: 5
parent: "4075"
status: open
scope: ["we:scripts/conveyor/run-rating.mjs", "we:scripts/conveyor/__tests__/run-rating.test.mjs", "we:scripts/operations/review-job.mjs", "we:scripts/operations/__tests__/review-job.test.mjs"]
dateOpened: "2026-09-27"
preparedDate: "2026-10-09"
preparedAgainstSha: "d0a843f021e2aefacc1fd77f53decf187fa0c8bd"
tags: []
---

# File the prevention guard(s) owed by chalbert/web-everything#2811's independent review

Preserve the eight prevention guards owed by chalbert/web-everything#2811's independent approval review. Current source still contains the underlying gaps; this is implementation plus regression coverage, not just filing tests for already-correct behavior.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#2811@e52307860e1308f40158e6ec13d6cab447f3bbeb

## Progress

- Original premise: the 2026-09-27 approval requested eight guards in the rating module, citing former lines 1090, 1495 and 475. Original scope was only that module and its test; original size was 3. Those line citations are stale. The corrected locations and outstanding behavior are recorded below.
- Cost aggregation still initializes to zero with no priced seats at `we:scripts/conveyor/run-rating.mjs:991`; the scanner already emits null for an unpriced seat at `we:scripts/conveyor/run-rating.mjs:1557`. Existing mixed-provider coverage at `we:scripts/conveyor/__tests__/run-rating.test.mjs:677` does not assert the all-unpriced joined-run case.
- The recording hook still omits its IO argument when calling the log reader at `we:scripts/conveyor/run-rating.mjs:1148`. Joined telemetry replaces tokens after waste was constructed (`we:scripts/conveyor/run-rating.mjs:880`, `we:scripts/conveyor/run-rating.mjs:1033`). Existing join tests start at `we:scripts/conveyor/__tests__/run-rating.test.mjs:666`; they do not exercise the recording hook.
- Coverage adds both non-Claude sources at `we:scripts/conveyor/run-rating.mjs:1667`; the existing isolated fixture at `we:scripts/conveyor/__tests__/run-rating.test.mjs:892` uses distinct seats, not overlap. Durable seat identity is available as sessionId and transcriptFile (`we:scripts/operations/run-record.mjs:124`); Codex transcript filenames carry the observed thread id (`we:scripts/lib/codex-judge-spawn.mjs:582`). No new producer identity format is needed.
- Story-size lookup falls back from item to PR number at `we:scripts/conveyor/run-rating.mjs:1216`; A-grade admission treats absent wall time as sufficient at `we:scripts/conveyor/run-rating.mjs:676`. Escalation waste ignores decisionReached at `we:scripts/conveyor/run-rating.mjs:811`, and the rating object omits that fact at `we:scripts/conveyor/run-rating.mjs:846`.
- Effective review ordering uses append-time scoredAt (`we:scripts/conveyor/run-rating.mjs:1723`, `we:scripts/conveyor/run-scorecard-store.mjs:353`). The job already captures its start instant but omits it from its returned summary (`we:scripts/operations/review-job.mjs:433-440`). Corrected scope includes that summary producer and its existing matching test, `we:scripts/operations/__tests__/review-job.test.mjs`, to persist actual execution time rather than invent a timestamp at rating time.
- Run storage has also moved: `we:scripts/operations/run-store.mjs:68` defines the shared runs directory, while the rating join still defaults to a clone-local directory (`we:scripts/conveyor/run-rating.mjs:984`) and coverage scans clone directories (`we:scripts/conveyor/run-rating.mjs:1580`). Include shared storage discovery in the existing rating-module scope, retaining explicit test overrides and legacy discovery.
- Size corrected from **3 to 5**: the evidence above establishes eight interacting behavior/guard changes, shared-directory reconciliation, and a second source/test pair for execution-time propagation. The goal remains all eight original guards. This preparation changes no implementation and does not claim passing regression evidence; stamping and checks belong to the runner.

## Design

1. **Unknown cost:** factor seat token/cost normalization into one internal helper consumed by the joined-run reader and scanner. Aggregate cost is null when no seat prices, numeric for priced seats (including a real zero), and partial when any seat is unpriced. Keep unpriced usage in token totals.
2. **IO propagation and current storage:** forward IO from rateAndRecordReviewJob to rateReviewJobLog. Use the existing sharedRunsDir resolver from `we:scripts/operations/run-store.mjs:68` for default joins and include that location in coverage discovery. Explicit runsDir/runsDirs must remain authoritative for hermetic tests. Deduplicate discovered directories and repeated run ids when legacy and shared copies coexist.
3. **Coverage reconciliation:** retain seat identity through scanning. Prefer recorded telemetry for a seat and exclude only its positively matched fallback transcript from coverage. Match recorded transcriptFile first, then provider/session identity; never equate seats merely by tokens, model, PR, or lens. Preserve unmatched fallback usage. Cover the same identity across discovered copies too.
4. **Namespace separation:** resolve story size only through an explicit item association; a PR number alone cannot serve as a backlog id. Preserve existing item-only rollups and propagate an explicit item carried by another row in the same demand group.
5. **Whole-run waste:** recompute escalation waste after telemetry joins so it uses the final token bag. Carry decisionReached through rateTranscript and require it to be false/absent before emitting escalated-no-decision. Keep the default conservative; do not infer decisions from prose.
6. **A-grade evidence:** require finite, nonnegative wallMs within the existing baseline limit. Preserve all other mandatory conditions and existing B/C/D deductions; null or omitted duration cannot earn A. This implements the existing conjunction documented at `we:scripts/conveyor/run-rating.mjs:642`, not a new grading rubric.
7. **Execution chronology:** emit reviewStartedAt (proposed field) from the job's captured t0, pass it through the log reader and toScorecardRow, and compare actual execution instants when resolving later review rounds. Keep scoredAt as ingestion time. For older joined runs, use a valid earliest stepTimings.startedAt as execution evidence (`we:scripts/operations/run-record.mjs:366`); absent evidence stays unknown, never synthesized from insertion order or file mtime. Equal or unknown execution times do not establish a strictly later round. Keep stored pending grades immutable and derive effective grades at report time. Group comparisons by repository and PR.

## MVP

- Implement the seven design steps (step 5 covers both original waste guards) within the two scoped source files and their matching tests.
- Add a small pure report-ordering seam in `we:scripts/conveyor/run-rating.mjs` if needed to exercise the same logic buildReport uses, rather than testing a duplicate implementation.
- Keep fixtures temporary and inject all scan/store roots. Use the existing scorecard store's extra-field support and injected IO; no scorecard schema rewrite, production backfill, provider change, live review dispatch, or new grading policy is needed.

## Test plan

Extend `we:scripts/conveyor/__tests__/run-rating.test.mjs` with:

- Shared seat normalization cases: all unpriced, all priced, mixed, priced zero, empty telemetry and missing run. Assert token bags, null/numeric cost and partial-cost status in both scanner and join paths.
- A direct rateAndRecordReviewJob fixture with an injected run directory and isolated scorecard IO; assert both returned and persisted joined tokens/cost. Include missing-log failure with no append and shared-directory/legacy-copy discovery cases.
- One known non-Claude seat in both telemetry and its transcript: require exactly one contribution to totalTokens; a distinct unmatched seat must still contribute. Include identity-free records to ensure no guessed deduplication, and repeated copies of a run to prevent double counting.
- PR/backlog-number collision with a size resolver spy: PR-only rows must not invoke the item resolver; explicit item rows must resolve the right size, including association appearing later in a demand's rows.
- An escalated job log plus real temporary run JSON through the recording hook: waste tokens must equal the sum of all four final token counters in both returned and stored data. Check decisionReached true suppresses this cause in classifyRunWaste and through rateTranscript; omitted/false still emits it.
- Parameterized A-grade tests for valid, excessive, null, omitted, negative and non-finite wall time, plus independent failures of every other mandatory condition.
- Historical accept then bounce fixtures inserted in opposite orders with differing scoredAt values but fixed reviewStartedAt: identical effective grades. Include equal/unknown execution times, different PR/repository, non-pending rows, and later evidence outside a report window. Assert original stored grades stay unchanged.

Extend `we:scripts/operations/__tests__/review-job.test.mjs` to use the injected clock and assert reviewStartedAt equals job start in the returned summary, independent of completion time. Exercise that summary through the rating/row conversion fixture as well.

## Proof plan

During implementation, first run the new targeted regression cases against the old behavior and record the specific failing assertions for the eight original guards. Then run the same suites after the fixes, exclusively through the host heavy-run queue. From the WE checkout, queue Vitest for `we:scripts/conveyor/__tests__/run-rating.test.mjs` and `we:scripts/operations/__tests__/review-job.test.mjs` using the runner `we:scripts/readiness/heavy-admission.mjs` (strip the visible we: repository prefix when passing filesystem arguments). Queue `npm run check:standards` through that same runner.

Retain before/after results for the isolated full path: job summary → log reader → run telemetry → recording hook → stored row → effective report grade. Compare exact token counts and grades, not merely successful execution. No production scorecard writes or paid judge calls are needed. Mutation-check that dropping IO forwarding, restoring PR-number fallback, summing overlapping sources, using scoredAt chronology, or removing decisionReached propagation makes the corresponding assertion fail.

## Follow-ups

- Historical production backfill is outside this prevention change; old rows without execution evidence remain unknown/pending rather than acquiring fabricated chronology.
- Cross-model judgment and deciding whether an escalation actually reached a decision remain parent #4075 concerns. This item consumes an explicit decisionReached fact only.
- No blockedBy change is proposed: the current producer already exposes the clock, seat identity and step timing primitives required for these guards.

## Done when

All eight approval debts have executable regression assertions, current shared run storage is observed by the rating reader, execution chronology survives recording, and the queued affected suites and standards gate pass. Each source entry in scope has its matching existing test file. No original guard is discharged by prose alone.
