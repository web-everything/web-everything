---
bornAs: x22nzem
kind: story
size: 8
status: open
scope: ["we:scripts/lane-pool.mjs", "we:scripts/__tests__/lane-pool*.test.mjs", "we:scripts/operations/review-job.mjs", "we:scripts/operations/__tests__/review-job*.test.mjs", "we:scripts/conveyor/reconcile-fix-dispatch.mjs", "we:scripts/conveyor/__tests__/reconcile-fix-dispatch*.test.mjs", "we:scripts/operations/dispatch-lane-io.mjs", "we:scripts/operations/__tests__/dispatch-lane-io.test.mjs", "we:scripts/operations/ci-heal-pr-dispatch.mjs", "we:scripts/operations/__tests__/ci-heal-pr-dispatch.test.mjs", "we:scripts/operations/dispatch-lane.mjs", "we:scripts/operations/__tests__/dispatch-lane.test.mjs", "we:scripts/operations/dispatch-providers/fix.mjs", "we:scripts/operations/dispatch-providers/__tests__/fix.test.mjs", "we:scripts/operations/__tests__/dispatch-provider-registry.test.mjs", "we:scripts/operations/fix-run.mjs", "we:scripts/operations/__tests__/fix-run.test.mjs", "we:scripts/operations/probation-build-run.mjs", "we:scripts/operations/__tests__/probation-build-run.test.mjs", "we:scripts/operations/dispatch-providers/probation-worker.mjs", "we:scripts/operations/dispatch-providers/__tests__/probation-worker.test.mjs", "we:scripts/operations/__tests__/dispatch-lane-routing-record.test.mjs", "we:skills-src/conveyor/fix-agent-brief.md", "we:skills-src/conveyor/fix-agent-ci-brief.md", "we:skills-src/conveyor/prepare-scope-agent-brief.md", "we:scripts/operations/__tests__/dispatch-lane-fixture-harness.test.mjs", "we:scripts/operations/__tests__/dispatch-lane-build-wiring.test.mjs", "we:vitest.config.ts", "we:vitest.integration.config.ts"]
dateOpened: "2026-10-12"
preparedDate: "2026-10-13"
preparedAgainstSha: "227d63ce6ff2c7aa63c47948f83503e15ba3169f"
tags: []
---

# Dispatcher leases the lane and hands it to fix/ci-heal/prepare workers; review jobs never lease a PR own lane

Reserve the actual worker checkout before launching a fresh fix, CI-heal, or scope-prepare worker, and hand that lease to the worker without a second allocation. Read-only reviews must use a free checkout other than the PR's own lane. Historical motivation: held finding 224 (coroner-5) reported 52 lane-already-leased events across 61 of 254 sessions during October 9–10, including jobs cf57089e, 872b486d, ad057938, 095515ac, 5506fbff and CI-heal session 001f51be. Those counts are incident evidence supplied with this card, not re-measured during preparation. Related #5439 supplies the build-reservation precedent.

## Design

1. Extend the reservation boundary in `we:scripts/operations/dispatch-lane-io.mjs:1353` to fresh fix, ci-heal and prepare launches; preserve the existing build switch and behavior. The `WE_DISPATCH_RESERVE_LANE` switch keeps gating build only; fresh fix, ci-heal and prepare reservation does not depend on it, and a payload missing its lane or session refuses instead of skipping reservation. Reserve after admission/claim checks but before any worker process starts. Share this mechanism with the separate fix launcher in `we:scripts/conveyor/reconcile-fix-dispatch.mjs:1307`. A free-list result is only a candidate: actual acquire must win before spawn. A busy candidate produces a bounded, retryable no-lane refusal, never a worker started to discover contention.
2. Carry a structured handoff containing repository/pool identity, lane number/path, lease session and generation/holder, and expected base. Repair reservation uses the PR head ref; prepare uses its existing base and card-only scope. Thread the repair base through `we:scripts/operations/ci-heal-pr-dispatch.mjs:279` into the sink. Preserve current scope derivation, including the existing empty-scope CI-heal behavior; do not broaden authorizations. Source, documentation, configuration and data paths receive the same lease protection.
3. Extend adoption in `we:scripts/lane-pool.mjs:4314` with expected lease identity validation and a race-safe check/update coordinated with release/reclaim. Existing adoption checks liveness and occupant but does not authenticate the expected dispatch lease. Handoff adoption must reject stale, replaced, wrong-repository or wrong-session leases; never force a takeover. Preserve the original holder and release identity. The worker declares its own durable occupant, not the dispatcher's session. Re-adoption of the same handoff is idempotent and must not reset checkout contents.
4. Update the three active brief templates in scope to consume a supplied handoff and adopt before edits. Retain explicit standalone acquisition when no handoff was supplied; a malformed supplied handoff must not fall back to acquiring another lane. Update the briefing contract in `we:scripts/operations/dispatch-lane.mjs` and test real template expansion. The Codex fix path must forward the handoff through `we:scripts/operations/dispatch-providers/fix.mjs` to `we:scripts/operations/fix-run.mjs`, whose acquisition currently occurs at line 493. The probation provider must forward it to `we:scripts/operations/probation-build-run.mjs:329`, using the same acquired lane before starting the sandbox worker. Keep launchers responsible for lease operations where sandbox workers cannot perform them.
5. Release only the exact reservation on a provably pre-launch failure. Once launch may have happened, retain the lease and report the indeterminate handle for existing reconciliation; never free a potentially occupied lane. Successful wrappers retain their existing terminal cleanup responsibilities. A resume uses its already owned checkout and allocates no new lane. Keep PR dispatch claims distinct from checkout leases.
6. Remove the preferred-lane-first behavior in `we:scripts/operations/review-job.mjs:694`. Resolve the PR's own lane identity from existing PR/lane metadata and exclude it from auto-selection, rather than merely dropping the preference (auto-pick could select that same lane). Add an exclusion option to the pool's acquire selection and apply it on every retry/growth selection. Scope the exclusion to its repository/pool. If an own-lane identity is supplied but invalid or its lookup fails, defer rather than silently ignore it. If the PR has no local mapped checkout, ordinary auto-pick is valid. Preserve job-slot and bounded-wait protections.

## MVP

Deliver one lease lifecycle across the active fresh Claude fix/CI-heal/prepare routes, the Codex fix route, and probation prepare/CI-heal routes: admission → acquire → launch → adopt/use → terminal release. Include the review exclusion and failure cleanup in the same change. Do not ship a path that reserves one checkout and subsequently allocates another. Keep unavailable mechanical prepare/CI-heal runtimes unavailable; their restoration is separate work, not a prerequisite. The existing build reservation is a regression case, not a new rollout decision.

## Acceptance

- [A1] The two queued test commands below (integration tier, then unit tier) name every test file in the Test plan, each under the vitest config that owns it, and both must pass after implementation. Vitest treats each path as a filter and silently drops a path that matches nothing, so a green exit alone is not enough. A1 fails if any named file is missing from the run output, any test named in the Test plan is absent, or any named test is skipped, marked todo, or runs zero cases. Every newly added contention, handoff and truncation case must fail against the current implementation.
- [A2] Must refuse before spawn on contention or invalid handoff; no force-taking, foreign release, or silent second acquisition.
- [A3] Must apply identical ownership checks to source, docs, configuration and data scopes, including empty-scope CI-heal without inventing a scope.
- [A4] Review auto-selection must exclude the PR's own lane even when that lane is free; resumed fixes must consume zero additional lanes.
- [A5] Definite spawn failure releases the matching reservation; an uncertain spawn retains it and remains observable.
- [A6] Truncated or incomplete pool state, lease records and supplied handoff data fail closed. Acquire, adopt and dispatch refuse; no free lane is guessed; no fallback acquisition, takeover or release happens; existing lease generation, holder, occupant and checkout contents stay unchanged. The four `truncated` tests mapped below enforce this.

## Test plan

Use hermetic temporary repositories and injectable launchers; never exercise the workstation pool in unit tests. Matching tests are included alongside every source entry in scope; brief coverage belongs to `we:scripts/operations/__tests__/dispatch-lane-fixture-harness.test.mjs`.

Every test below is named in backticks. A1 checks each name in each file listed for it. Planned files are marked; every other file already exists and is extended.

**Pool — integration tier.** Both pool files use real temporary git repositories and spawned `we:scripts/lane-pool.mjs` contenders, like their `lane-pool-*` siblings. So each joins the `include` list of `we:vitest.integration.config.ts` and the `exclude` list of `we:vitest.config.ts`, and runs in the first A1 command below.

- `we:scripts/__tests__/lane-pool-dispatch-handoff.test.mjs` (planned, not an existing suite):
  - `acquire never selects an excluded lane` — on first pick, retry and growth selection; the exclusion applies only within its own repository/pool.
  - `acquire refuses when every candidate is excluded`
  - `two contenders for one lane: exactly one wins and the loser gets a bounded no-lane refusal`
  - `adopt accepts only the expected repository, pool, session and generation` — refuses a wrong pool, wrong session, stale generation, and a partial expected identity (for example, generation missing); a symlinked pool root and its real path resolve to the same identity.
  - `adopt refuses a lease replaced between read and update`
  - `re-adopting the same handoff is idempotent and keeps checkout contents`
  - `worker occupant is recorded apart from the dispatcher holder and release identity` — checked in the lease and the journal.
  - `applies identical lease checks to source, docs, config and data scopes` — at adoption.
  - Every case asserts no foreign marker or checkout change.
- `we:scripts/__tests__/lane-pool-truncated-state.test.mjs` (planned, not an existing suite):
  - `rejects truncated pool state without selecting a free lane`
  - `rejects truncated lease records without changing ownership`
  - Parameterize each over a mid-record cut, valid JSON missing required ownership fields, a bounded read returning only a prefix (page/record limit, byte-buffer cap or last-N-lines window), and a read error surfaced as empty data. Assert acquire/adopt refuses, no fallback or takeover occurs, and existing lease generation, holder, occupant and checkout contents remain unchanged.

**Dispatch boundary — unit tier.** Add each of these to `we:scripts/operations/__tests__/dispatch-lane-io.test.mjs`, `we:scripts/conveyor/__tests__/reconcile-fix-dispatch.test.mjs` and `we:scripts/operations/__tests__/ci-heal-pr-dispatch.test.mjs`, for every fresh fix, CI-heal and prepare route that file reaches:

- `acquire precedes every fresh spawn`
- `busy candidate gives a bounded retryable no-lane refusal and zero spawn`
- `reservation carries the correct repository, base, scope and lease identity`
- `applies identical lease checks to source, docs, config and data scopes` — at reservation.
- `fresh routes reserve with WE_DISPATCH_RESERVE_LANE unset` — fix, CI-heal and prepare reserve whatever that flag says. A payload missing its lane or session refuses before spawn and never returns a silent `reserved:false` that lets launch go ahead.
- `resume acquires no lane`
- `definite spawn failure releases the reservation exactly once`
- `uncertain spawn retains the reservation and reports its handle`
- `dispatcher exit before adoption leaves the lease held, not freed`
- `retry cannot release a replacement lease`
- `truncated reservation data refuses dispatch before spawn` — inject each pool-state/lease-record failure shape above through the reservation boundary; assert zero child starts, no guessed free lane or second acquisition, and no release or mutation of an existing lease.
- `untrusted refs and scopes reach acquire and launch as separate argv values` — values containing quotes, newlines, a leading `--` or `..`.

In `we:scripts/operations/__tests__/ci-heal-pr-dispatch.test.mjs` only, also add `empty-scope CI-heal is leased without inventing a scope`: the reservation and handoff carry the existing empty scope unchanged and pass the same ownership checks as a scoped route.

In `we:scripts/operations/__tests__/dispatch-lane-build-wiring.test.mjs`, add `build reservation keeps its WE_DISPATCH_RESERVE_LANE behavior` (the regression case the MVP names).

**Review — unit tier.** In `we:scripts/operations/__tests__/review-job.test.mjs`:

- `auto-selection excludes the PR's own lane when it is free`
- `auto-selection excludes the PR's own lane when it is occupied`
- `invalid or failed own-lane lookup defers instead of ignoring it`
- `no local mapping uses ordinary auto-pick`
- `full pool defers within the bounded wait and keeps job-slot limits`

**Workers and providers — unit tier.**

- In `we:scripts/operations/__tests__/fix-run.test.mjs` and `we:scripts/operations/__tests__/probation-build-run.test.mjs`:
  - `uses the supplied handoff lane and acquires no second checkout`
  - `standalone invocation without a handoff still acquires its own lane`
  - `truncated supplied handoff refuses launch or adoption without standalone fallback` — cover each truncation/read-failure shape above, including valid JSON missing repository/pool, lane, session/generation/holder or expected-base fields; assert refusal before launcher spawn or worker edits, zero fallback acquisition, and unchanged lease ownership/occupancy.
  - `definite launch failure releases the handed-off lease once and uncertain launch retains it`
  - In `we:scripts/operations/__tests__/probation-build-run.test.mjs` only: `missing mechanical runtime is refused, not restored`.
- In `we:scripts/operations/dispatch-providers/__tests__/fix.test.mjs` and `we:scripts/operations/dispatch-providers/__tests__/probation-worker.test.mjs` (both planned, not existing suites; probation covers its prepare and CI-heal branches with injected launch and attempt hooks):
  - `forwards the handoff to the launcher argv`
  - `refuses a malformed handoff before spawn`
  - `standalone invocation is unchanged`
  - `truncated supplied handoff refuses launch or adoption without standalone fallback`
  - `untrusted refs and scopes reach acquire and launch as separate argv values`
- In `we:scripts/operations/__tests__/dispatch-provider-registry.test.mjs`: `prepare and CI-heal keep their default mode and forward the handoff`.
- In `we:scripts/operations/__tests__/dispatch-lane-routing-record.test.mjs`: `routing record carries the lease identity end to end`.

**Briefs — unit tier.** In `we:scripts/operations/__tests__/dispatch-lane.test.mjs` and `we:scripts/operations/__tests__/dispatch-lane-fixture-harness.test.mjs`, using real template expansion of the three briefs:

- `filled briefs adopt the supplied handoff before any edit`
- `filled briefs acquire standalone only when no handoff is supplied`
- `handoff values are filled into brief commands as single quoted arguments`
- `applies identical lease checks to source, docs, config and data scopes` — one case per scope kind.
- In `we:scripts/operations/__tests__/dispatch-lane-fixture-harness.test.mjs` only: `truncated supplied handoff refuses launch or adoption without standalone fallback`.

Guarantee → enforcing tests (all files are in the A1 commands below):

| guarantee | named tests |
| --- | --- |
| A2 refuse on contention/invalid handoff | `two contenders…`, `busy candidate…`, `adopt accepts only the expected…`, `refuses a malformed handoff…`, `fresh routes reserve with WE_DISPATCH_RESERVE_LANE unset` |
| A3 identical checks per scope kind; empty-scope CI-heal | `applies identical lease checks…` (reservation, adoption, briefs), `empty-scope CI-heal…` |
| A4 review excludes own lane; resume takes no lane | `auto-selection excludes the PR's own lane…` (free, occupied), `resume acquires no lane`, `uses the supplied handoff lane…` |
| A5 definite failure releases, uncertain retains and is observable | `definite spawn failure…`, `uncertain spawn retains…reports its handle`, `definite launch failure…` (fix-run, probation) |
| A6 / edge 2 truncated data fails closed | `rejects truncated pool state…`, `rejects truncated lease records…`, `truncated reservation data…`, `truncated supplied handoff…` |
| Edge 1 untrusted text | `untrusted refs and scopes…`, `handoff values are filled into brief commands as single quoted arguments` |
| Edge 3 shared state | `two contenders…`, `adopt refuses a lease replaced between read and update`, `retry cannot release a replacement lease` |
| Edge 4 fail closed | `refuses a malformed handoff…`, `uncertain spawn retains…`, `invalid or failed own-lane lookup defers…` |
| Edge 5 identity scoping | `adopt accepts only the expected…`, `acquire never selects an excluded lane` (pool-scoped) |
| Edge 6 state over time | `resume acquires no lane`, `dispatcher exit before adoption…`, `re-adopting the same handoff is idempotent…` |
| Edge 7 holder vs occupant | `worker occupant is recorded apart from the dispatcher holder…` |
| Build regression | `build reservation keeps its WE_DISPATCH_RESERVE_LANE behavior` |

Run affected tests only through the host queue (WE checkout-relative CLI arguments). These commands are the A1 gate. Between them they name every test file in this Test plan, each under the config that owns it:

```bash
node scripts/readiness/heavy-admission.mjs run -- npx vitest run --config vitest.integration.config.ts \
  scripts/__tests__/lane-pool-dispatch-handoff.test.mjs \
  scripts/__tests__/lane-pool-truncated-state.test.mjs
node scripts/readiness/heavy-admission.mjs run -- npx vitest run \
  scripts/operations/__tests__/dispatch-lane-build-wiring.test.mjs \
  scripts/operations/__tests__/dispatch-lane-io.test.mjs \
  scripts/conveyor/__tests__/reconcile-fix-dispatch.test.mjs \
  scripts/operations/__tests__/ci-heal-pr-dispatch.test.mjs \
  scripts/operations/__tests__/review-job.test.mjs \
  scripts/operations/__tests__/fix-run.test.mjs \
  scripts/operations/__tests__/probation-build-run.test.mjs \
  scripts/operations/dispatch-providers/__tests__/fix.test.mjs \
  scripts/operations/dispatch-providers/__tests__/probation-worker.test.mjs \
  scripts/operations/__tests__/dispatch-provider-registry.test.mjs \
  scripts/operations/__tests__/dispatch-lane-routing-record.test.mjs \
  scripts/operations/__tests__/dispatch-lane.test.mjs \
  scripts/operations/__tests__/dispatch-lane-fixture-harness.test.mjs
node scripts/readiness/heavy-admission.mjs run -- npm run check:standards
```

Check the run output against A1: all 15 files appear (2 in the integration run, 13 in the unit run), and every named test above ran and passed in each file listed for it. Any other test file the implementation touches also runs through the same queue; it adds to this command and never replaces it.

## Proof plan

Add explicit negative tests in an isolated disposable pool for truncated pool state, lease records and handoff data: cut each payload mid-record and at a syntactically valid boundary that omits required ownership fields; also simulate a bounded read that returns only a prefix and a read error reported as empty data. Exercise each supported fresh dispatch route through the dispatcher/launcher boundary and worker adoption where applicable. Assert dispatch/adoption is refused, no child starts on refused dispatch or edits a checkout after refused adoption, no free-lane fallback or takeover occurs, and existing lease generations, ownership and occupancy remain unchanged. Record each injected payload/read failure and the observed rejection; these tests must pass before graduation.

Before graduation, use an isolated disposable pool and controlled child workers through the real dispatcher/launcher boundary. Pause each fresh worker after dispatch acquisition, attempt competing acquisition, then let the worker adopt. Record the lease generation, repository, lane path, worker identity, child start time and pool journal: exactly one lease must span dispatch and work, the competitor must fail, and the child must edit only that checkout. Repeat for fix, CI-heal, prepare and supported probation/Codex routes. Run a read-only review while the PR-own lane is free and prove it selects another lane. Inject definite launch failure, uncertain launch acknowledgement and dispatcher exit between acquisition and adoption; observe cleanup or retained/reconciled occupancy without displacing a live worker. Record commands and observed output in this card at implementation time. Preparation itself does not claim these probes have passed.

## Non-goals

- Changing pool size, routing/model policy, retry budgets, review authority, PR claims, or the build reservation rollout.
- Restoring absent mechanical runtimes, changing prepare-decision behavior, or treating a resume as a fresh dispatch.
- New HTTP endpoints: body-size caps, rate limiting, CSRF/origin checks do not apply. Existing local CLI admission and argument validation remain in force.

## Edge cases this change must handle

1. **Untrusted text** — pass refs/scopes/identities as validated argv data; no shell interpolation of PR or card prose.
2. **Truncated reads** — incomplete pool/lease/handoff data refuses dispatch; never guess a free lane. Enforced by [A6] and the four named `truncated` tests in the Test plan.
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
- Review repair (PR 5140, round 3): the truncated-data tests were named but their files were missing from the A1 command, so a passing A1 run never executed them. Every Test-plan file is now named exactly (no globs) and listed in the A1 command; new files are marked planned. A1 now fails on a missing file, absent test or zero-case run. [A6] states the truncated-data guarantee. Every planned test is now named, and a guarantee → test table maps A2–A6, all seven edge cases and the build regression to named tests. The two new pool files are integration tier, so A1 runs them under `we:vitest.integration.config.ts` (both configs and `we:scripts/operations/__tests__/dispatch-lane-build-wiring.test.mjs` join scope). Design point 1 now states that `WE_DISPATCH_RESERVE_LANE` gates build only, and a payload missing its lane or session refuses.
