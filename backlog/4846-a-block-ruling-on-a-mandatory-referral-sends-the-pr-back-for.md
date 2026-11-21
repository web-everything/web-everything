---
bornAs: xkoqlar
kind: story
size: 3
status: open
scope: ["we:scripts/lib/jury-core.mjs", "we:scripts/operations/review-pr.mjs", "we:scripts/operations/review-pr-io.mjs", "we:scripts/lib/__tests__/jury-core.test.mjs", "we:scripts/operations/__tests__/review-pr.test.mjs", "we:scripts/operations/__tests__/review-pr-io.test.mjs", "we:scripts/conveyor/__tests__/review-referral-hold.test.mjs"]
dateOpened: "2026-10-02"
preparedDate: "2026-11-21"
preparedAgainstSha: "8ffe94186965e88906fd79cc47e822d76181e416"
tags: []
---

# A block ruling on a mandatory referral sends the PR back for changes instead of re-asking

A valid independent current-head block must complete an actionable changes review, carrying the finding and ruling rationale to the author and fixer. Preserve pending obligations, human authority, and the existing same-head dispatch protections.

## Progress

Re-preparation inspected the acquired checkout. Old premise/scope: blocked keys alone reached the verdict, resolved comments sounded pending, and reconciliation might need a new route. Corrected premise: validated blocked findings already flow from `we:scripts/lib/jury-core.mjs:3675` through aggregation at `we:scripts/lib/jury-core.mjs:4059` to `we:scripts/operations/review-pr.mjs:3199`. Deferred findings are promoted at `we:scripts/operations/review-pr.mjs:3208`; resolved-record wording already exists at `we:scripts/lib/jury-core.mjs:3744`. The planner already emits a block-ruled fix at `we:scripts/conveyor/reconcile-core.mjs:3672`. These are existing controls, not work to reimplement.

The remaining gap is narrower: blocked finding objects omit the counted ruling rationale/evidence, although the per-record evaluator returns counted rulings (`we:scripts/lib/jury-core.mjs:3683`). Final publication consumes panel findings (`we:scripts/operations/review-pr.mjs:1973`); a persisted block with no fresh panel finding still encounters the juror-count-only reasonless-bounce guard (`we:scripts/operations/review-pr.mjs:2140`). This is not already delivered. The incident's reported 33 dispatches and responder-journal diagnosis remain unverified historical context, not evidence of the present cause.

Scope correction: retain jury core, operation, sink and their tests; replace speculative planner production edits and generic planner tests with the existing block-ruled integration cases in `we:scripts/conveyor/__tests__/review-referral-hold.test.mjs:952`. Sink reuse already exists at `we:scripts/operations/review-pr-io.mjs:1350` and `we:scripts/operations/review-pr-io.mjs:1565`; inspect its returned projection and publication checks, not a new retry policy. The durable harness is now at `we:scripts/operations/__tests__/review-pr-io.test.mjs:2231`, and promotion controls at `we:scripts/operations/__tests__/review-pr.test.mjs:4231`. Earlier line citations are superseded by these references.

Size changes from 2 to 3: expected changes are approximately 45 lines in the core projection, 65 in verdict rendering/guard, up to 20 in sink projection, 65 core test lines, 110 operation test lines, 80 sink test lines, and 50 planner integration test lines (about 435 across seven scoped files). The extra size reflects the publication/restart integration proof, not a new dispatch feature. No defaults or authority policy change is proposed. Existing preparation stamps are left for the runner to replace.

## Design

1. Enrich each counted blocked-finding projection with its validated active ruling details: rationale, evidence, ruling identity, source run, reviewer/operator identity, and reviewed head. Join inside the evaluator using its counted rulings, never raw result strings. Preserve multiple compatible active rulings and existing operator supersession, linked-finding and carry semantics. Linked blocks must identify their counted backing; do not invent independent evidence for the linked copy. Keep durable record storage compatible and fields additive.
2. Carry this projection through aggregation, the durable sink result, and the referral verdict. Render a separate mandatory-block section in the final changes write-up with the original finding, rationale and evidence, using existing untrusted-text rendering helpers. Keep panel votes unchanged. Deduplicate presentation by existing finding identity/key rules. Reuse that section for advisory output where applicable; do not change the shared panel's meaning.
3. Let the shared staging/recording guard accept validated actionable blocked-referral evidence as a reason for changes even when fresh panel findings are empty. Both callers use `planRecordDecision` in `we:scripts/operations/review-pr.mjs:2100`; neither may bypass pending-referral, human-label or acceptance checks. A legacy cached blocked-key-only result must refresh through the durable sink before being used as ruling evidence; absent/unreadable evidence remains a visible hold/refusal, never an invented override reason.
4. Preserve default unattended changes behavior, unrelated needs-human outcomes and explicit human gates. The existing lone-answer hold exception in `we:scripts/operations/review-pr.mjs:3221` is already policy; do not broaden or remove it. No changed configuration defaults, new judge retries, or synthetic acceptance markers.
5. Feed the actual published changes body and labels into existing planner tests. Keep current fix routing, live-work exclusion, caps and new-head review rules. Production planner changes are outside this corrected touch set; a discovered planner defect requires a separately evidenced scope correction.

## MVP

Must: validated ruling-to-write-up transport, persisted-block completion with an empty fresh panel, unchanged fail-closed/human controls, and a synthetic end-to-end operation/sink/planner replay. Cover source, docs, config and data findings using the same path. Could: replay historical incident artifacts when available; this is not a prerequisite to the synthetic proof. No new confidence policy, finding-identity algorithm or retry budget.

## Acceptance

Each executable entry names a proposed regression group; add it to the named existing suite. The positive handoff assertions must fail on the pre-build implementation and pass after. Negative cases in the same groups must stay green before and after; do not manufacture a failure by weakening a control.

- [A1] Executable: group `4846 counted block provenance` in `we:scripts/lib/__tests__/jury-core.test.mjs` asserts counted rationale/evidence and source identity survive aggregation, including supersession and linked blocks; stale, conflicting, malformed and unauthorized records never gain actionable authority.
- [A2] Executable: group `4846 persisted block completes changes` in `we:scripts/operations/__tests__/review-pr.test.mjs` drives referralVerdict, ordinary unattended confirmation, stageVerdict and record with an empty fresh panel. Both publication callers produce the same actionable finding/rationale/evidence without operator reason or fabricated panel votes. Parameterize source/docs/config/data.
- [A3] Executable: group `4846 legacy and mixed holds` in `we:scripts/operations/__tests__/review-pr-io.test.mjs` refreshes old persisted state into the enriched projection, then tests block plus pending key, unreadable evidence, post/read-back failure and head movement. No acceptance or false completion; unrelated human holds remain. The refreshed provenance assertion is the red-to-green delta; refusal assertions are controls.
- [A4] Executable: group `4846 published bounce replay` in `we:scripts/conveyor/__tests__/review-referral-hold.test.mjs` consumes the real rendered body/labels from the operation and sink, asserts the rationale reaches fixer input, one eligible fix and no duplicate live fix or same-head review over repeated ticks; a pushed/rearmed new head remains reviewable. Assert rationale transport as the failing-before delta, not the already-working dispatch route.
- [A5] Executable: group `4846 restart reuses counted block` in `we:scripts/operations/__tests__/review-pr-io.test.mjs` repeats across sink instances and run IDs, asserting one judge attempt, durable read-back before publication and enriched ruling details on each successful resume. Existing attempt limits and failure recovery remain unchanged.

## Test plan

Implement A1–A5 using existing hermetic harnesses with injected forge effects and real evaluator/operation/sink/planner functions. Exercise ordinary defaults and existing callers explicitly; avoid step-only mocks as the sole completion proof. Include operator supersession, unreadable linked cards, missing author identity, attempted-but-unfinished records, unrelated human gates and legacy key-only results. Preserve the existing promotion assertions in `we:scripts/operations/__tests__/review-pr.test.mjs:4231` and durable publication controls in `we:scripts/operations/__tests__/review-pr-io.test.mjs:2231`.

## Proof plan

From the WE repository, execute each affected suite through the host queue. Command form: `node "$QUEUE" run --wait-ms=60000 -- npx vitest run "$TEST"`, where QUEUE is the repo-relative filesystem spelling of `we:scripts/readiness/heavy-admission.mjs` and TEST is the repo-relative spelling of each test in scope (strip the locus prefix when executing). Use the four scoped suites, including the corrected planner integration suite. Run `node "$QUEUE" run --wait-ms=60000 -- npm run check:standards` after implementation. If admission remains busy after this one bounded wait, stop and report it.

Record before/after assertion output, durable snapshots, judge count, confirmation answer, staged/published body equality, label transitions, fixer input and repeated-tick/new-head decisions. No live PR mutation. Preparation itself changes only this card; implementation regressions are specified here, not claimed executed. Runner owns preparation checks and stamping.

## Follow-ups

Obtain pinned historical incident artifacts and reconcile review attempts versus durable snapshots before asserting the original loop's exact cause. The resolved-record renderer is already corrected; no speculative coordination dependency on historical card 4815 is needed. Any planner defect observed by A4 gets an evidenced follow-up or explicit scope amendment; preserve existing authority and finding-identity policy.
