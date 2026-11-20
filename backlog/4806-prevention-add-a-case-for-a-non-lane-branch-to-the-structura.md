---
bornAs: xezaii2
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/missing-run-push.mjs", "we:scripts/conveyor/__tests__/missing-run-push.test.mjs", "we:scripts/conveyor/soak/breaks/missing-run-structural-deferral-loops.mjs", "we:scripts/conveyor/soak/breaks/missing-run-structural-deferral-loops.soak.test.mjs", "we:scripts/conveyor/soak/breaks/__tests__/missing-run-structural-deferral-loops.test.mjs"]
dateOpened: "2026-10-01"
preparedDate: "2026-11-20"
preparedAgainstSha: "bf9bdd7cab5b0e35678bdc8936848f22cea38fe4"
tags: []
---

# Prevention — Count non-lane missing-run recovery failures and guard transient deferrals

Filed mechanically ON APPROVAL from chalbert/web-everything#3253: add a non-lane branch case to the structural-deferral soak and unit coverage, and require every deferral call to justify its transient classification.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3253@f2247f0abf422ce9259b71e418098f8b9da8d942

## Progress

- Old premise/scope: the original source/unit pair omitted the requested soak; the previous preparation added the break, wrapper and a wildcard unit-test path. It cited preflight at lines 31–34 and comment accounting at line 845, and treated marked tips as uniformly terminal.
- Corrected premise: we:scripts/conveyor/missing-run-push.mjs:67–69 still returns a free deferral for a valid non-lane input. This goal is not delivered. Static inspection also shows non-string branch values can throw into the counted catch instead of following that return; do not describe all malformed inputs as currently free deferrals. Current comment accounting is we:scripts/conveyor/ci-red-recovery-watch.mjs:1693–1706.
- Additional drift: we:scripts/conveyor/missing-run-push.mjs:107 now defers failed explicit admission; lines 130–174 implement marked-tip dispatch, including incomplete run evidence, young queued runs and final claim/head checks. The previous five-site transient list was incomplete: there are eleven direct calls today, ten after replacing the structural preflight. Preserve these existing fail-closed behaviors and justify their retry conditions; do not revert marked-tip dispatch.
- Caller evidence: we:scripts/conveyor/ci-red-recovery-watch.mjs:1690 routes stacked PRs to restack, not trigger. The soak's current three cases are stacked, fork and ineligible credential (we:scripts/conveyor/soak/breaks/missing-run-structural-deferral-loops.mjs:34–42); its header/title incorrectly say marked-tip. Its executor throws on git, but the recovery catch absorbs that exception, so throwing alone cannot prove zero git calls. Its assertions at lines 64–73 only bound attempts and require some comments, not exactly two.
- Corrected scope: retain the two production-test files and break/wrapper; replace the wildcard with planned we:scripts/conveyor/soak/breaks/__tests__/missing-run-structural-deferral-loops.test.mjs (directory currently absent). No sweep or shared admission-policy change is needed. Inject existing sweep seams to isolate the historical stacked case and all external reads.
- Size remains 3: approximately 40 changed lines in we:scripts/conveyor/missing-run-push.mjs, 110 in we:scripts/conveyor/__tests__/missing-run-push.test.mjs, 60 in we:scripts/conveyor/soak/breaks/missing-run-structural-deferral-loops.mjs, 90 in its planned unit test, and up to 5 in we:scripts/conveyor/soak/breaks/missing-run-structural-deferral-loops.soak.test.mjs. This is one bounded recovery regression, not a new policy subsystem. This preparation uses source inspection, not a claimed runtime probe; the runner owns stamping and checks.

## Design

In we:scripts/conveyor/missing-run-push.mjs, make the combined structural preflight return `{ ok: false, action: 'pull-request-push', error }` without `deferred`, before executing commands. Explicitly type-check the branch so malformed values do not depend on a caught TypeError. Preserve the current repository, safe-integer PR and SHA predicates and lane-prefix eligibility; expanding those validators is outside this prevention. The changed default is accounting for rejected input, not eligibility or push permission.

Require every remaining direct `defer` call to supply a literal site reason and nonempty retry justification in addition to its existing error. Keep those annotations internal and preserve the public result shape. A test-local source guard in we:scripts/conveyor/__tests__/missing-run-push.test.mjs must enumerate all calls and match an explicit reviewed site/reason/justification table; missing, unknown, dynamic or duplicate sites fail closed. Pin ten surviving sites: initial live PR, mergeability, initial claim, explicit admission, fetch race, run-list completeness, young run, dispatch claim, dispatch live PR and push claim. Distinguish the two live-head checks and three claim checkpoints. Negative source fixtures must exercise unannotated, unknown/structural, duplicate and dynamically supplied reasons.

Justifications describe the condition required for a later retry: refreshed PR state/head, repaired or recalculated mergeability, released/readable claims, a fresh head after fetch, complete run evidence, or a queued run aging/starting. Explicit admission is re-evaluated only with newly acquired eligible evidence and available budgets; identical refused evidence never authorizes a mutation. Preserve its existing free refusal and operator/ci-heal message, including spent/unreadable budgets, rather than reclassifying the shared admission contract in this item. Preserve marked-tip one-dispatch reservation, young-run timing and incomplete-list fail-closed behavior, including the existing 100-result bound.

In we:scripts/conveyor/soak/breaks/missing-run-structural-deferral-loops.mjs, give the fixture builder an optional branch used in both listing and live PR. Add a same-repo main-based non-lane case with valid SHA. Keep six ticks, explicitly inject cap two and fixed time/threshold, and inject cache, push-history, declared-context and other reached readers so user credentials, settings and daemon state cannot affect the result. Inject the stacked-case restack seam to exercise the historical push-refusal fixture; document that this case does not test production restacking. Fork, credential and non-lane cases still use the real trigger through the real sweep.

Record executor calls separately from exceptions. Return per-case attempts, comment counts, final refusal and git-call counts alongside violations, and require exactly two attempts, exactly two durable comments, cap exhaustion and zero git calls. Allow an optional injected recovery function for break unit tests; default to the real imported recovery function for the soak. Preserve the existing fix-presence predicate: it already selects required-pass mode, so adding the regression must make the old non-lane behavior fail rather than silently become expected-fail. Correct the break header/title to name actual cases.

## MVP

1. Add structural-input and annotation-guard regression tests in we:scripts/conveyor/__tests__/missing-run-push.test.mjs, including the ten-site behavioral matrix.
2. Add the non-lane fixture, explicit hermetic seams, observable counts and strict violations in we:scripts/conveyor/soak/breaks/missing-run-structural-deferral-loops.mjs. Add its exact scoped unit test; keep we:scripts/conveyor/soak/breaks/missing-run-structural-deferral-loops.soak.test.mjs as the real-sweep wrapper.
3. Capture failures with unchanged recovery source, then replace structural deferral and annotate surviving calls in we:scripts/conveyor/missing-run-push.mjs.
4. Run the focused checks below. Must ship all acceptance guarantees together; no new generic lint framework, shared admission policy, sweep behavior or settings.

## Acceptance

- [A1] Executable: planned test `structural inputs are counted without executor calls` in we:scripts/conveyor/__tests__/missing-run-push.test.mjs fails on current non-lane behavior and passes after the change. Table cases cover valid non-lane, absent/non-string branch, malformed repository, unsafe PR number and invalid SHA, asserting no `deferred`, an explanatory error, and zero executor calls.
- [A2] Executable: planned test `every deferral has a reviewed retry condition` in we:scripts/conveyor/__tests__/missing-run-push.test.mjs fails on the current unannotated source and passes with the ten-site table. The same test group rejects missing/unknown/structural/dynamic/duplicate annotations and reaches each real site with injected IO, checking free refusal and no push or dispatch. Include absent explicit evidence, spent budgets, incomplete/malformed and 100-result run lists, unreadable claims, both head checks and young-run timing; preserve existing eligible push and marked-tip dispatch success tests.
- [A3] Executable: we:scripts/conveyor/soak/breaks/missing-run-structural-deferral-loops.soak.test.mjs with the new non-lane fixture fails against unchanged recovery and passes after A1: exactly two attempts/comments, zero git calls and final `missing-run-cap-exhausted` with operator/ci-heal fallback. Existing structural cases remain covered; no production caller change is required.
- [A4] Executable: planned test `break detects free deferrals and exact-accounting violations` in we:scripts/conveyor/soak/breaks/__tests__/missing-run-structural-deferral-loops.test.mjs fails against the old break's missing case/report/injection seam. After implementation, injected old free-deferral behavior must produce violations while counted refusal passes; missing or excess comments, excess/missing attempts, hidden git calls and missing final handoff must be detected. Assert the existing fix-presence rule keeps the new regression in required-pass mode.

## Test plan

Use A1–A4 as the red/green regression inventory. In we:scripts/conveyor/__tests__/missing-run-push.test.mjs retain existing credential, fork, stacked, exact-lease, reservation, dispatch-failure and stale-head assertions. Extend the current malformed-run and young-run tests rather than weakening them. Explicit-admission caller compatibility is additionally checked by existing we:scripts/conveyor/__tests__/recovery-preflight.test.mjs; the sweep caller suite is we:scripts/conveyor/__tests__/ci-red-recovery-watch.test.mjs. Persisted legacy comment accounting stays covered by the existing missing-run unit suite. No live GitHub or git push is needed.

## Proof plan

During the build, capture red A1–A4 runs after adding tests/fixtures but before modifying recovery. Then run the identical focused suites green and retain the break report showing counts and final fallback. No red/green run is claimed by this preparation.

All commands below use repository-locus notation; remove `we:` from path arguments when executing from WE. Use the host queue once with a bounded wait; if admission remains busy, stop and report rather than polling.

- `node we:scripts/readiness/heavy-admission.mjs run --wait-ms=60000 -- npx vitest run we:scripts/conveyor/__tests__/missing-run-push.test.mjs we:scripts/conveyor/soak/breaks/__tests__/missing-run-structural-deferral-loops.test.mjs we:scripts/conveyor/__tests__/recovery-preflight.test.mjs we:scripts/conveyor/__tests__/ci-red-recovery-watch.test.mjs`
- `node we:scripts/readiness/heavy-admission.mjs run --wait-ms=60000 -- npx vitest run --config we:vitest.soak.config.ts we:scripts/conveyor/soak/breaks/missing-run-structural-deferral-loops.soak.test.mjs`
- `node we:scripts/readiness/heavy-admission.mjs run --wait-ms=60000 -- npm run check:standards`

The source guard proves annotation completeness; behavioral tests prove refusal semantics; the real-sweep soak proves durable accounting. These do not assert live CI startup.

## Follow-ups

None required for this prevention. Shared admission-policy reclassification, stricter PR/branch validation, production restacking changes and generic lint infrastructure remain outside scope. Preserve current fail-closed refusal messages and operator/ci-heal escalation.
