---
bornAs: x22nzem
kind: story
size: 8
status: open
scope: ["we:scripts/lane-pool.mjs", "we:scripts/__tests__/lane-pool*.test.mjs", "we:scripts/operations/review-job.mjs", "we:scripts/operations/__tests__/review-job*.test.mjs", "we:scripts/conveyor/reconcile-fix-dispatch.mjs", "we:scripts/conveyor/__tests__/reconcile-fix-dispatch*.test.mjs", "we:scripts/operations/dispatch-lane-io.mjs", "we:scripts/operations/__tests__/dispatch-lane-io.test.mjs", "we:scripts/operations/ci-heal-pr-dispatch.mjs", "we:scripts/operations/__tests__/ci-heal-pr-dispatch.test.mjs", "we:scripts/operations/dispatch-lane.mjs", "we:scripts/operations/__tests__/dispatch-lane.test.mjs", "we:scripts/operations/dispatch-providers/fix.mjs", "we:scripts/operations/dispatch-providers/__tests__/fix.test.mjs", "we:scripts/operations/__tests__/dispatch-provider-registry.test.mjs", "we:scripts/operations/fix-run.mjs", "we:scripts/operations/__tests__/fix-run.test.mjs", "we:scripts/operations/probation-build-run.mjs", "we:scripts/operations/__tests__/probation-build-run.test.mjs", "we:scripts/operations/dispatch-providers/probation-worker.mjs", "we:scripts/operations/dispatch-providers/__tests__/probation-worker.test.mjs", "we:scripts/operations/__tests__/dispatch-lane-routing-record.test.mjs", "we:skills-src/conveyor/fix-agent-brief.md", "we:skills-src/conveyor/fix-agent-ci-brief.md", "we:skills-src/conveyor/prepare-scope-agent-brief.md", "we:scripts/operations/__tests__/dispatch-lane-fixture-harness.test.mjs"]
dateOpened: "2026-10-12"
preparedDate: "2026-10-13"
preparedAgainstSha: "227d63ce6ff2c7aa63c47948f83503e15ba3169f"
tags: []
---

# Dispatcher leases the lane and hands it to fix/ci-heal/prepare workers; review jobs never lease a PR own lane

Reserve the actual worker checkout before launching a fresh fix, CI-heal, or scope-prepare worker, and hand that lease to the worker without a second allocation. Read-only reviews must use a free checkout other than the PR's own lane. Historical motivation: held finding 224 (coroner-5) reported 52 lane-already-leased events across 61 of 254 sessions during October 9–10, including jobs cf57089e, 872b486d, ad057938, 095515ac, 5506fbff and CI-heal session 001f51be. Those counts are incident evidence supplied with this card, not re-measured during preparation. Related #5439 supplies the build-reservation precedent.

## Design

1. Extend the reservation boundary in `we:scripts/operations/dispatch-lane-io.mjs:1353` to fresh fix, ci-heal and prepare launches; preserve the existing build switch and behavior. Reserve after admission/claim checks but before any worker process starts. Share this mechanism with the separate fix launcher in `we:scripts/conveyor/reconcile-fix-dispatch.mjs:1307`. A free-list result is only a candidate: actual acquire must win before spawn. A busy candidate produces a bounded, retryable no-lane refusal, never a worker started to discover contention.
2. Carry a structured handoff containing repository/pool identity, lane number/path, lease session and generation/holder, and expected base. Repair reservation uses the PR head ref; prepare uses its existing base and card-only scope. Thread the repair base through `we:scripts/operations/ci-heal-pr-dispatch.mjs:279` into the sink. Preserve current scope derivation, including the existing empty-scope CI-heal behavior; do not broaden authorizations. Source, documentation, configuration and data paths receive the same lease protection.
3. Extend adoption in `we:scripts/lane-pool.mjs:4314` with expected lease identity validation and a race-safe check/update coordinated with release/reclaim. Existing adoption checks liveness and occupant but does not authenticate the expected dispatch lease. Handoff adoption must reject stale, replaced, wrong-repository or wrong-session leases; never force a takeover. Preserve the original holder and release identity. The worker declares its own durable occupant, not the dispatcher's session. Re-adoption of the same handoff is idempotent and must not reset checkout contents.
4. Update the three active brief templates in scope to consume a supplied handoff and adopt before edits. Retain explicit standalone acquisition when no handoff was supplied; a malformed supplied handoff must not fall back to acquiring another lane. Update the briefing contract in `we:scripts/operations/dispatch-lane.mjs` and test real template expansion. The Codex fix path must forward the handoff through `we:scripts/operations/dispatch-providers/fix.mjs` to `we:scripts/operations/fix-run.mjs`, whose acquisition currently occurs at line 493. The probation provider must forward it to `we:scripts/operations/probation-build-run.mjs:329`, using the same acquired lane before starting the sandbox worker. Keep launchers responsible for lease operations where sandbox workers cannot perform them.
5. Release only the exact reservation on a provably pre-launch failure. Once launch may have happened, retain the lease and report the indeterminate handle for existing reconciliation; never free a potentially occupied lane. Successful wrappers retain their existing terminal cleanup responsibilities. A resume uses its already owned checkout and allocates no new lane. Keep PR dispatch claims distinct from checkout leases.
6. Remove the preferred-lane-first behavior in `we:scripts/operations/review-job.mjs:694`. Resolve the PR's own lane identity from existing PR/lane metadata and exclude it from auto-selection, rather than merely dropping the preference (auto-pick could select that same lane). Add an exclusion option to the pool's acquire selection and apply it on every retry/growth selection. Scope the exclusion to its repository/pool. If an own-lane identity is supplied but invalid or its lookup fails, defer rather than silently ignore it. If the PR has no local mapped checkout, ordinary auto-pick is valid. Preserve job-slot and bounded-wait protections.

## MVP

Deliver one lease lifecycle across the active fresh Claude fix/CI-heal/prepare routes, the Codex fix route, and probation prepare/CI-heal routes: admission → acquire → launch → adopt/use → terminal release. Include the review exclusion and failure cleanup in the same change. Do not ship a path that reserves one checkout and subsequently allocates another. Keep unavailable mechanical prepare/CI-heal runtimes unavailable; their restoration is separate work, not a prerequisite. The existing build reservation is a regression case, not a new rollout decision.

## Acceptance

- [A1] The queued test command below must pass after implementation; newly added deterministic contention/handoff cases must fail against the current implementation.
- [A2] Must refuse before spawn on contention or invalid handoff; no force-taking, foreign release, or silent second acquisition.
- [A3] Must apply identical ownership checks to source, docs, configuration and data scopes, including empty-scope CI-heal without inventing a scope.
- [A4] Review auto-selection must exclude the PR's own lane even when that lane is free; resumed fixes must consume zero additional lanes.
- [A5] Definite spawn failure releases the matching reservation; an uncertain spawn retains it and remains observable.

## Test plan

Use hermetic temporary repositories and injectable launchers; never exercise the workstation pool in unit tests. Matching tests are included alongside every source entry in scope; brief coverage belongs to `we:scripts/operations/__tests__/dispatch-lane-fixture-harness.test.mjs`.

- Extend pool tests under `we:scripts/__tests__/lane-pool*.test.mjs` for excluded lanes, all candidates excluded, two contenders, expected-session/generation adoption, replacement between read and update, idempotent adoption, and wrong-pool rejection. Assert no foreign marker or checkout changes.
- Extend `we:scripts/operations/__tests__/review-job*.test.mjs` for free and occupied PR-own lanes, unavailable identity lookup, no local mapping, bounded pool-full deferral, and preserved job-slot behavior.
- Extend `we:scripts/operations/__tests__/dispatch-lane-io.test.mjs`, `we:scripts/conveyor/__tests__/reconcile-fix-dispatch*.test.mjs` and `we:scripts/operations/__tests__/ci-heal-pr-dispatch.test.mjs`: acquire precedes every fresh spawn; busy means zero spawn; correct repo/base/scope/lease identity; resume means zero acquire; definite failure releases once; ambiguous failure retains; retry cannot release a replacement lease.
- Extend `we:scripts/operations/__tests__/fix-run.test.mjs`, `we:scripts/operations/__tests__/probation-build-run.test.mjs`, `we:scripts/operations/__tests__/dispatch-provider-registry.test.mjs` and `we:scripts/operations/__tests__/dispatch-lane-routing-record.test.mjs` for end-to-end handoff forwarding and no second checkout. Include standalone invocation and missing-runtime refusals.
- Add `we:scripts/operations/dispatch-providers/__tests__/fix.test.mjs` and `we:scripts/operations/dispatch-providers/__tests__/probation-worker.test.mjs` for provider-local handoff forwarding through captured launcher argv, malformed-handoff refusal before spawn, and preservation of standalone invocation. Cover probation prepare and CI-heal branches with injected launch and attempt hooks; retain the broader routing and wrapper tests above. These are planned test files, not existing suites.
- Extend `we:scripts/operations/__tests__/dispatch-lane.test.mjs` and `we:scripts/operations/__tests__/dispatch-lane-fixture-harness.test.mjs` for actual filled brief instructions and required/invalid handoff fields, across source/docs/config/data scopes.

Run affected tests only through the host queue, for example (WE checkout-relative CLI arguments):

```bash
node scripts/readiness/heavy-admission.mjs run -- npx vitest run scripts/operations/__tests__/dispatch-lane-io.test.mjs scripts/operations/__tests__/review-job.test.mjs scripts/conveyor/__tests__/reconcile-fix-dispatch.test.mjs scripts/operations/__tests__/ci-heal-pr-dispatch.test.mjs scripts/operations/__tests__/fix-run.test.mjs scripts/operations/__tests__/probation-build-run.test.mjs scripts/operations/__tests__/dispatch-lane-fixture-harness.test.mjs
node scripts/readiness/heavy-admission.mjs run -- npm run check:standards
```

Run the remaining affected test files through that same queue before delivery, including any newly authored pool tests.

## Proof plan

Before graduation, use an isolated disposable pool and controlled child workers through the real dispatcher/launcher boundary. Pause each fresh worker after dispatch acquisition, attempt competing acquisition, then let the worker adopt. Record the lease generation, repository, lane path, worker identity, child start time and pool journal: exactly one lease must span dispatch and work, the competitor must fail, and the child must edit only that checkout. Repeat for fix, CI-heal, prepare and supported probation/Codex routes. Run a read-only review while the PR-own lane is free and prove it selects another lane. Inject definite launch failure, uncertain launch acknowledgement and dispatcher exit between acquisition and adoption; observe cleanup or retained/reconciled occupancy without displacing a live worker. Record commands and observed output in this card at implementation time. Preparation itself does not claim these probes have passed.

## Non-goals

- Changing pool size, routing/model policy, retry budgets, review authority, PR claims, or the build reservation rollout.
- Restoring absent mechanical runtimes, changing prepare-decision behavior, or treating a resume as a fresh dispatch.
- New HTTP endpoints: body-size caps, rate limiting, CSRF/origin checks do not apply. Existing local CLI admission and argument validation remain in force.

## Edge cases this change must handle

1. **Untrusted text** — pass refs/scopes/identities as validated argv data; no shell interpolation of PR or card prose.
2. **Truncated reads** — incomplete pool/lease/handoff data refuses dispatch; never guess a free lane.
3. **Shared state files** — acquire, adopt and conditional release must coordinate against competing release/reclaim; no read-then-overwrite of a replacement lease.
4. **Fail closed** — invalid handoff or ambiguous launch cannot trigger takeover or premature release.
5. **Identity scoping** — qualify lane identity by repository/pool plus lease generation/session; a reusable slug alone is insufficient.
6. **State over time** — retries, process death, delayed adoption and resumes preserve ownership and existing reconciliation behavior.
7. **Who wrote it** — distinguish dispatcher lease holder from worker occupant and retain that lineage in observable lease/journal records.

## Follow-ups

- Mechanical prepare/CI-heal graduation must consume this handoff if those absent runtimes return; do not recreate their stale provider comments as implementation here.
- Compare post-delivery contention outcomes with the historical finding only after collecting a comparable observation window; unit success alone does not establish an incident-rate improvement.

## Progress

- Preparation inspection: original scope named only `we:scripts/lane-pool.mjs`, `we:scripts/operations/review-job.mjs` and `we:scripts/conveyor/reconcile-fix-dispatch.mjs`, with no tests. Original premise treated workers uniformly as acquiring a named lane and reviews as already falling back to auto-pick.
- Corrected premise: `we:scripts/operations/dispatch-lane-io.mjs:1353-1366` already reserves builds only, gated by an environment flag; `we:scripts/operations/dispatch-lane-io.mjs:1535` is the shared pre-spawn hook. The separate fix path still documents free-list selection without reservation at `we:scripts/conveyor/reconcile-fix-dispatch.mjs:25-41` and launches at its own `dispatchFix` boundary (line 1307). CI-heal reaches the shared sink at `we:scripts/operations/ci-heal-pr-dispatch.mjs:279`. These observations establish remaining work, not an already-delivered goal.
- Review drift: `we:scripts/operations/review-job.mjs:694-699` first tries a preferred lane, then auto-picks. Merely removing that preference does not enforce the title's exclusion. Current adoption at `we:scripts/lane-pool.mjs:4314-4333` lacks expected-dispatch-lease validation and directly rewrites the marker, so handoff identity and race tests are required.
- Worker topology drift: `we:scripts/operations/fix-run.mjs:493-500` independently acquires and later releases a lane; `we:scripts/operations/probation-build-run.mjs:329` also acquires. `we:scripts/operations/dispatch-provider-registry.mjs:99-134` defaults prepare/CI-heal to agent mode. The provider-referenced `we:scripts/operations/prepare-scope-run.mjs` and `we:scripts/operations/ci-heal-run.mjs` are absent in this checkout; their comments cannot establish a live runtime. Active acquisition instructions are at `we:skills-src/conveyor/fix-agent-brief.md:123`, `we:skills-src/conveyor/fix-agent-ci-brief.md:128` and `we:skills-src/conveyor/prepare-scope-agent-brief.md:62`.
- Corrected scope adds shared dispatch, CI-heal payload plumbing, worker/provider consumers and the three briefs, with matching existing tests or permitted pool/review/fix test patterns. Size changes **3 → 8**: approximately 150–220 changed lines in pool ownership/exclusion, 180–260 across shared/separate dispatch and payload plumbing, 100–160 across worker/provider consumers, 40–70 in review selection, 40–70 in briefs, and 300–450 in associated tests (roughly 810–1,230 total). This is a story, so no `estimatedLoc` is added. The source boundaries above support the larger estimate.
- No dependency change proposed. Preparation edits only this card; runner-owned stamping, gates and review remain pending. Historical incidents were not replayed and implementation tests were not run for this documentation-only preparation.
- Prepare-validation repair: the previous scope paired provider sources only with broader registry/routing tests; it omitted matching provider-local test paths. Add planned `we:scripts/operations/dispatch-providers/__tests__/fix.test.mjs` and `we:scripts/operations/dispatch-providers/__tests__/probation-worker.test.mjs` to scope and the test plan. Evidence: argv construction and spawn at `we:scripts/operations/dispatch-providers/fix.mjs:105-131` and `we:scripts/operations/dispatch-providers/probation-worker.mjs:136-169` provide injectable boundaries for direct handoff tests. Neither planned suite exists yet. The implementation scope and size **8** remain unchanged; the provider suites allocate coverage already included in the associated-test estimate above.
