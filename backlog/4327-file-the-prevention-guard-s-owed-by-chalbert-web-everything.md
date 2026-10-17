---
bornAs: xkhionl
kind: story
size: 5
parent: "4075"
status: open
scope: ["we:scripts/conveyor/run-rating.mjs", "we:scripts/conveyor/__tests__/run-rating.test.mjs", "we:scripts/operations/review-job.mjs", "we:scripts/operations/__tests__/review-job.test.mjs"]
dateOpened: "2026-09-27"
preparedDate: "2026-10-17"
preparedAgainstSha: "0ac57a4150ca02b1dbb7455f5b195ea268392d3b"
tags: []
---

# File the prevention guard(s) owed by chalbert/web-everything#2811's independent review

Preserve the eight prevention guards owed by chalbert/web-everything#2811's independent approval review. Current source still contains the underlying gaps; this is implementation plus regression coverage, not just filing tests for already-correct behavior.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#2811@e52307860e1308f40158e6ec13d6cab447f3bbeb

## Progress

- Historical premise: the 2026-09-27 approval requested eight guards in the rating module, citing former lines 1090, 1495 and 475. The initial scope was the rating source/test pair and size 3; the previous preparation expanded it to the review-job source/test pair and size 5. This re-preparation retains **size 5** and those four scoped files. No implementation, status change or new stamp is made here.
- Corrected premise at this checkout: all eight gaps remain in source; this is implementation plus regression coverage, not tests for behavior already delivered. The previous preparation's review-job summary citation now points into unrelated code: the captured start and result constructor are at `we:scripts/operations/review-job.mjs:700-707`. Existing clock injection and arc coverage are at `we:scripts/operations/__tests__/review-job.test.mjs:158-197`.
- **G1 — unknown cost:** the join initializes cost to zero at `we:scripts/conveyor/run-rating.mjs:991`; the scanner correctly emits null for an unpriced seat at `we:scripts/conveyor/run-rating.mjs:1572`. The mixed-provider join test at `we:scripts/conveyor/__tests__/run-rating.test.mjs:677` does not cover an all-unpriced joined run.
- **G2 — recording IO:** the hook calls the log reader without IO at `we:scripts/conveyor/run-rating.mjs:1159`. Existing join coverage at `we:scripts/conveyor/__tests__/run-rating.test.mjs:664` invokes the reader directly, bypassing the recording hook.
- **G3 — coverage overlap:** coverage sums recorded non-Claude usage and fallback transcript usage at `we:scripts/conveyor/run-rating.mjs:1677`; the isolated fixture at `we:scripts/conveyor/__tests__/run-rating.test.mjs:890` uses distinct seats. Scanning currently discards identity at `we:scripts/conveyor/run-rating.mjs:1569`. The producer already preserves sessionId/transcriptFile (`we:scripts/operations/run-record.mjs:124`), and Codex filenames encode the observed thread id or an explicit unknown marker (`we:scripts/lib/codex-judge-spawn.mjs:589`). No new producer identity format is required.
- **G4 — namespaces:** story-size resolution still falls back from item to PR number at `we:scripts/conveyor/run-rating.mjs:1230`. The group's item is initialized only from its first row at `we:scripts/conveyor/run-rating.mjs:1201-1209`, so an explicit association appearing later also needs propagation.
- **G5 — joined waste:** review waste is constructed with zero tokens at `we:scripts/conveyor/run-rating.mjs:880`, before joined tokens replace the rating bag at `we:scripts/conveyor/run-rating.mjs:1034-1039`.
- **G6 — A-grade evidence:** absent duration satisfies the A predicate at `we:scripts/conveyor/run-rating.mjs:676`; negative duration also satisfies its numeric comparison. This conflicts with the existing within-baseline conjunction documented at `we:scripts/conveyor/run-rating.mjs:643`.
- **G7 — decision propagation:** escalation waste ignores decisionReached at `we:scripts/conveyor/run-rating.mjs:810`; rateTranscript passes it to grading but omits it from the rating consumed by waste classification at `we:scripts/conveyor/run-rating.mjs:844-857`.
- **G8 — chronology:** effective grades use append-time scoredAt at `we:scripts/conveyor/run-rating.mjs:1734` and group only by PR at `we:scripts/conveyor/run-rating.mjs:1742-1746`. The store supplies ingestion time and preserves extra fields at `we:scripts/conveyor/run-scorecard-store.mjs:353`. The summary already has repo, but the rating/row conversion drops it (`we:scripts/conveyor/run-rating.mjs:1032-1041`, `we:scripts/conveyor/run-rating.mjs:1093-1105`). Carry repo alongside execution time; no store edit is needed. Older run records have validated step start times at `we:scripts/operations/run-record.mjs:367-377`.
- Storage correction within the existing rating scope: default joins remain clone-local (`we:scripts/conveyor/run-rating.mjs:984`), and coverage discovers clone directories only (`we:scripts/conveyor/run-rating.mjs:1593-1594`). The canonical producer gives OPERATION_RUNS_DIR precedence over the shared resolver (`we:scripts/operations/run-store.mjs:113-117`), whose shared-path override is WE_SHARED_RUNS_DIR (`we:scripts/operations/run-store.mjs:68-71`). Calling resolveRunsDir would also migrate files (`we:scripts/operations/run-store.mjs:118-120`); rating reads must instead honor the same path precedence without that mutation.
- Touch-set estimate supporting retained size 5: approximately 140–200 changed lines in `we:scripts/conveyor/run-rating.mjs`, 220–300 in `we:scripts/conveyor/__tests__/run-rating.test.mjs`, 3–8 in `we:scripts/operations/review-job.mjs`, and 15–30 in `we:scripts/operations/__tests__/review-job.test.mjs`. These cover eight guards, shared/legacy discovery and timestamp/repository propagation. Existing helpers cited above are dependencies to consume, not additional edit targets. As a story, this card keeps size rather than estimatedLoc.

## Design

1. **Unknown cost:** factor seat token/cost normalization into one internal helper consumed by the joined-run reader and scanner. Aggregate cost is null when no seat prices and numeric for priced seats (including a real zero). Preserve the joined costUsdPartial signal when any seat is unpriced; an all-unpriced join must never imply a known zero. Keep unpriced usage in token totals. Empty/missing telemetry retains the existing job-log-only fallback.
2. **IO propagation and current storage:** forward IO from rateAndRecordReviewJob to rateReviewJobLog. Use explicit runsDir first for joins, otherwise OPERATION_RUNS_DIR when set, otherwise the pure sharedRunsDir resolver from `we:scripts/operations/run-store.mjs:68`. Default coverage includes the configured/shared location and legacy clone directories. Explicit runsDirs (including an empty array) replaces discovery entirely. Expose an injected shared root/environment for discovery tests so a temporary workspaceRoot never leaks into real shared storage. Do not call the migrating resolveRunsDir from a read path. Deduplicate canonical directories and repeated run ids; the configured/shared copy wins over a legacy copy, matching the migration precedence at `we:scripts/operations/run-store.mjs:77`. Select the authoritative copy before applying the existing mtime window.
3. **Coverage reconciliation:** retain seat identity through scanning. Prefer recorded telemetry for a seat and exclude only its positively matched fallback transcript from coverage. Match normalized recorded transcriptFile first, then provider/session identity from the recorded model family and observed transcript thread id/filename; unknown-generated filename suffixes are not observed session ids; never equate seats merely by tokens, model, PR, or lens. Preserve unmatched fallback usage. Exclude a transcript only when its matching telemetry actually contributes within the requested window. Cover the same identity across discovered copies too; equal token totals alone never justify removing a seat.
4. **Namespace separation:** resolve story size only through an explicit item association; a PR number alone cannot serve as a backlog id. Preserve existing item-only rollups and propagate an explicit item carried by another row in the same demand group.
5. **Whole-run waste:** recompute escalation waste after telemetry joins so it uses the final token bag. Carry decisionReached through rateTranscript and require it to be false/absent before emitting escalated-no-decision. Keep the default conservative; do not infer decisions from prose.
6. **A-grade evidence:** require finite, nonnegative wallMs within the existing baseline limit. Preserve all other mandatory conditions and existing B/C/D deductions; null or omitted duration cannot earn A. This implements the existing conjunction documented at `we:scripts/conveyor/run-rating.mjs:642`, not a new grading rubric.
7. **Execution chronology:** emit reviewStartedAt (proposed field, ISO timestamp) from the job's captured t0, pass it and the existing summary repo through the log reader and toScorecardRow, and compare actual execution instants when resolving later review rounds. Keep scoredAt as ingestion time. For older joined runs, use a valid earliest stepTimings.startedAt as execution evidence (`we:scripts/operations/run-record.mjs:367`); absent evidence stays unknown, never synthesized from insertion order or file mtime. Equal or unknown execution times do not establish a strictly later round. Keep stored pending grades immutable and derive effective grades at report time. Group comparisons by repository and PR, using the existing DEFAULT_REPO_SLUG convention for legacy rows without repo. Validate execution timestamps; a valid summary start takes precedence over the earliest valid joined step start. Extract step timing even when telemetry is absent, so lack of token evidence does not erase available chronology.

## MVP

- Implement the seven design steps (step 5 covers G5 and G7; the other steps map to G1–G4, G6 and G8) within the two scoped source files and their matching tests.
- Add a small pure report-ordering seam in `we:scripts/conveyor/run-rating.mjs` if needed to exercise the same logic buildReport uses, rather than testing a duplicate implementation.
- Keep fixtures temporary and inject all scan/store roots. Use the existing scorecard store's extra-field support and injected IO; no scorecard schema rewrite, production backfill, provider change, live review dispatch, or new grading policy is needed.

## Test plan

Extend `we:scripts/conveyor/__tests__/run-rating.test.mjs` with:

- Shared seat normalization cases: all unpriced, all priced, mixed, priced zero, empty telemetry and missing run. Assert token bags, null/numeric cost and partial-cost status in both scanner and join paths.
- A direct rateAndRecordReviewJob fixture with an injected run directory and isolated scorecard IO; assert both returned and persisted joined tokens/cost. Include missing-log failure with no append; explicit directory and environment precedence; explicit empty runsDirs; shared-directory/legacy-copy discovery with different contents and mtimes; and an assertion that reading leaves both source copies untouched.
- One known non-Claude seat in both telemetry and its transcript: require exactly one contribution to totalTokens; a distinct unmatched seat must still contribute. Include identity-free records to ensure no guessed deduplication, and repeated copies of a run to prevent double counting. Test exact-path and provider/session matches, same session id in different providers, unknown ids, and telemetry excluded by the time window with a still-in-window fallback transcript.
- PR/backlog-number collision with a size resolver spy: PR-only rows must not invoke the item resolver; explicit item rows must resolve the right size, including association appearing later in a demand's rows.
- An escalated job log plus real temporary run JSON through the recording hook: waste tokens must equal the sum of all four final token counters in both returned and stored data. Check decisionReached true suppresses this cause in classifyRunWaste and through rateTranscript; omitted/false still emits it.
- Parameterized A-grade tests for valid, excessive, null, omitted, negative and non-finite wall time, plus independent failures of every other mandatory condition.
- Historical accept then bounce fixtures inserted in opposite orders with differing scoredAt values but fixed reviewStartedAt: identical effective grades. Include equal/unknown execution times, different PR/repository, non-pending rows, and later evidence outside a report window. Assert original stored grades stay unchanged. Check summary-time precedence, invalid/missing timestamps, earliest valid step fallback, and step-only run records without telemetry. Assert repo survives summary → rating → stored row before testing cross-repository isolation; a manually constructed row alone would miss the current field loss.

Extend `we:scripts/operations/__tests__/review-job.test.mjs` to use the injected clock and assert reviewStartedAt equals job start in the returned summary, independent of completion time. Exercise that summary through the rating/row conversion fixture as well.

## Proof plan

During implementation, first run the new targeted regression cases against the old behavior and record the specific failing assertions for the eight original guards. Then run the same suites after the fixes, exclusively through the host heavy-run queue. From the WE checkout, queue Vitest for `we:scripts/conveyor/__tests__/run-rating.test.mjs` and `we:scripts/operations/__tests__/review-job.test.mjs` using the runner `we:scripts/readiness/heavy-admission.mjs` (strip the visible we: repository prefix when passing filesystem arguments). Queue `npm run check:standards` through that same runner.

Retain before/after results for the isolated full path: job summary → log reader → run telemetry → recording hook → stored row → effective report grade. Compare exact token counts and grades, not merely successful execution. No production scorecard writes or paid judge calls are needed. Mutation-check that dropping IO forwarding, restoring PR-number fallback, summing overlapping sources, using scoredAt chronology, or removing decisionReached propagation makes the corresponding assertion fail.

## Follow-ups

- Historical production backfill is outside this prevention change; old rows without execution evidence remain unknown/pending rather than acquiring fabricated chronology.
- Cross-model judgment and deciding whether an escalation actually reached a decision remain outside this prevention item under parent #4075; the parent is a tracking epic, not evidence that a decision detector exists. This item consumes an explicit decisionReached fact only.
- No blockedBy change is proposed: the current producer already exposes the clock, seat identity and step timing primitives required for these guards.

## Done when

All eight approval debts have executable regression assertions, current shared run storage is observed by the rating reader, execution chronology survives recording, and the queued affected suites and standards gate pass. Each source entry in scope has its matching existing test file. No original guard is discharged by prose alone.
