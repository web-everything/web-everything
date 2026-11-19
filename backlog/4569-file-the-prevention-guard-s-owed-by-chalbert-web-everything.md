---
bornAs: xitlhgo
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/__tests__/probation-build-run.test.mjs", "we:scripts/lib/__tests__/dispatch-contracts-route.test.mjs"]
dateOpened: "2026-09-29"
preparedDate: "2026-11-18"
preparedAgainstSha: "2f60bed9ab55a6ffbdc78041abc29d7e1f2395c1"
tags: []
---

# File the prevention guard(s) owed by chalbert/web-everything#3038's independent review

Filed mechanically on approval to track six prevention debts: prepare empty-diff diagnostics; critical prepare routing; scope-aware routing; explicit refusal coverage; dispatch-to-runner lease integration; and a cross-task decline matrix. Preserve these regression guarantees against the current implementation, rather than restoring historical routing behavior.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3038@566638ce874d45aa7504abbb449871e689b3c59e

## Progress

- Original premise: the six review findings cited runner lines 319/373, routing line 1147, and runner-test line 757 as uncovered behavior; the scope included two production modules and their generic test files. Those coordinates no longer identify the relevant branches.
- Corrected premise: prepare already recognizes explicit blocked reports and preserves their message (we:scripts/operations/probation-build-run.mjs:603); the regression at we:scripts/operations/__tests__/probation-build-run.test.mjs:1235 checks a could-not-prepare finding without stamping or resolving. Invalid or absent reports deliberately remain failures (we:scripts/operations/__tests__/probation-build-run.test.mjs:1270). Zero files alone is not permission to accept an invalid preparation.
- Routing now evaluates the actual card path, falling back to implementation scope only when no card path exists (we:scripts/lib/dispatch-contracts.mjs:1386). Existing tests explicitly allow critical implementation scope with a noncritical card, and deny high risk, critical card paths, critical misses, and critical scope without a card path (we:scripts/lib/__tests__/dispatch-contracts-route.test.mjs:409). The old proposal to always deny critical implementation scope contradicts this current contract. Preserve the current contract and extend its negative evidence; no new policy choice is required.
- Remaining gaps: direct runner rejection of active cards and unsupported prepare workers, a stamp that adds an extra path, an all-five-task decline matrix, and one test carrying actual provider argv through runner validation. The existing launcher test stops at argv assertions (we:scripts/operations/__tests__/prepare-probation-routing.test.mjs:14); the runner independently creates its card-only envelope (we:scripts/operations/probation-build-run.mjs:437). The provider forwards the supplied lease unchanged (we:scripts/operations/dispatch-providers/probation-worker.mjs:165).
- Scope correction: tests only, in we:scripts/operations/__tests__/probation-build-run.test.mjs and we:scripts/lib/__tests__/dispatch-contracts-route.test.mjs. Production modules are read-only subjects; generic dispatch-contract tests are replaced by the existing route-specific suite. Retain size 3: approximately 160 changed lines in the runner suite (matrix, refusal cases, integrated argv fixture) plus 40 in the routing suite (boundary matrix), about 200 lines total. No estimatedLoc: this is a story. No stamps authored by this preparation.

## Design

Use existing injectable IO fixtures and real exported routing, provider, argument-parser, and runner functions. Extend the runner suite with a named `4569` regression group; keep fixture helpers local and reuse the existing prepare fixture. Stub process spawning and publication, never launch a worker or contact GitHub.

For declines, parameterize doc-fix, bugfix, test-fix, build-new-feature, and prepare, using valid scope and eligible workers per task. Use an explicit unresolved-choice report for prepare, avoiding the separately handled spec-defect and already-done branches. Assert current outcome differences: prepare returns could-not-prepare; build tasks record a finding and open its PR. In every row preserve the sanitized final diagnostic, leave the item unresolved, avoid a successful build claim, and assert no gate-red/crash. Keep malformed prepare reports and failed workers as negative controls.

For routing, preserve card-path precedence and the fallback to implementation scope. Extend the existing card-envelope group with statute-tier paths, missing scope evidence, and unavailable fallback coverage. Assert no probationWorker when the gate closes; unavailable Claude must refuse with a reason rather than invent an eligible worker. Do not change provider defaults or persisted routing policy.

The integrated case starts with an implementation-scoped prepare dispatch plus its concrete cardPath, obtains the real route, passes the target-card lease to probationWorkerDetachedProvider, captures its argv, parses it, and runs runProbationBuild using injected IO. Assert that only the target card is stamped and committed. Its paired negative uses an implementation-only lease and must refuse the same card edit before publication. This distinguishes predicted implementation scope from the actual prepare write lease.

## MVP

1. Add the five-task decline matrix and malformed-report/failed-worker controls.
2. Add direct runner tests for status active, antigravity-claude in prepare mode, and a stamp that adds a second changed path. Assert exact refusal category and absence of downstream side effects.
3. Extend routing boundary coverage without altering existing card-envelope expectations.
4. Add the real provider-argv → parser → runner integration pair using the existing runner IO fixture.
5. Treat the refusal inventory below as the required test-plan checklist for this change; no generic lint framework or production refactor is needed.

## Acceptance

- [A1] Executable — `4569 decline matrix` in we:scripts/operations/__tests__/probation-build-run.test.mjs covers all five supported task types, diagnostic preservation and task-specific finding outcomes, with failed-worker and malformed-prepare controls. Missing any row must fail the matrix's explicit supported-task assertion.
- [A2] Executable — `4569 prepare refusal branches` in we:scripts/operations/__tests__/probation-build-run.test.mjs checks active-card refusal before worker execution, direct unsupported-worker rejection before IO, and post-stamp extra-path gate-red with discard and no commit/PR.
- [A3] Executable — `4569 routing boundaries` in we:scripts/lib/__tests__/dispatch-contracts-route.test.mjs checks critical/statute implementation scope with a safe card, critical/statute card scope, absent cardPath fallback, absent scope evidence, and unavailable Claude fallback. Existing default-route expectations stay intact.
- [A4] Executable — `4569 provider argv reaches runner` in we:scripts/operations/__tests__/probation-build-run.test.mjs proves the card lease succeeds and the implementation-only lease refuses, using actual provider-produced argv rather than hand-built runner arguments.

These are planned test names, not claims that tests already exist. For each A-label, first verify that its named test group is absent on the parent and present after the build, then run that group through the host queue. The absence check supplies the before-build failure for this regression-only item; additionally prove each new guard detects a targeted production mutation as described below. Do not claim existing production behavior fails simply because coverage is missing.

## Test plan

Use the queued command below from the WE root. The shell variables strip the required repository prefix from visible path references before invoking Node/Vitest.

```sh
queue=we:scripts/readiness/heavy-admission.mjs
runner=we:scripts/operations/__tests__/probation-build-run.test.mjs
routes=we:scripts/lib/__tests__/dispatch-contracts-route.test.mjs
node "${queue#we:}" run -- npx vitest run "${runner#we:}" "${routes#we:}"
```

Refusal checklist: active card → not-applicable/no worker; unsupported prepare worker → rejection/no IO; extra stamp path → gate-red/discard/no publication; malformed prepare report → no recorded finding; failed worker → no acceptance; wrong lease → no commit/PR; unknown routing evidence → no probation worker; unavailable safe fallback → explicit refusal. Assert calls and output, not merely a non-success result. No new defaults, settings, or persisted-state migration are introduced.

## Proof plan

Record parent SHA and the absence/presence result for each A-label's exact test name. Run only the two scoped suites through the heavy queue. For regression sensitivity, temporarily mutate one guard at a time: drop the decline message or route empty diffs to gate-red; bypass active/worker/post-stamp checks; substitute implementation scope for cardPath or admit unknown evidence; drop the provider's scope argument. Each matching test must fail, then pass after restoration. Keep mutations out of the final diff and report which assertion caught each one.

The integration must observe the provider-produced arguments, acquired lease, runner outcome, committed path list, and prohibited-call counts. No live provider, lane acquisition, commit, push, or PR is needed: injected IO records these actions. If the host queue is busy, use its bounded wait once and report the limit rather than polling. The runner owns preparation stamping and final checks.

## Follow-ups

The historical alternative of a generic gate-kinds-reader lint or coverage-of-refusals lint is not needed for this bounded regression work; this card chooses concrete tests and the explicit branch checklist. A general lint can be considered separately if repeated omissions justify it. Preserve existing already-done verification and spec-defect re-scope tests; broadening those workflows or changing criticality policy is outside this story. No blockedBy changes are proposed.
