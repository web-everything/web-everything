---
bornAs: x22nzem
kind: story
size: 8
status: open
scope: ["we:scripts/lane-pool.mjs", "we:scripts/__tests__/lane-pool*.test.mjs", "we:scripts/operations/review-job.mjs", "we:scripts/operations/__tests__/review-job*.test.mjs", "we:scripts/conveyor/reconcile-fix-dispatch.mjs", "we:scripts/conveyor/__tests__/reconcile-fix-dispatch*.test.mjs", "we:scripts/operations/dispatch-lane-io.mjs", "we:scripts/operations/__tests__/dispatch-lane-io.test.mjs", "we:scripts/operations/ci-heal-pr-dispatch.mjs", "we:scripts/operations/__tests__/ci-heal-pr-dispatch.test.mjs", "we:scripts/operations/dispatch-lane.mjs", "we:scripts/operations/__tests__/dispatch-lane.test.mjs", "we:scripts/operations/dispatch-providers/fix.mjs", "we:scripts/operations/dispatch-providers/__tests__/fix.test.mjs", "we:scripts/operations/__tests__/dispatch-provider-registry.test.mjs", "we:scripts/operations/fix-run.mjs", "we:scripts/operations/__tests__/fix-run.test.mjs", "we:scripts/operations/probation-build-run.mjs", "we:scripts/operations/__tests__/probation-build-run.test.mjs", "we:scripts/operations/dispatch-providers/probation-worker.mjs", "we:scripts/operations/dispatch-providers/__tests__/probation-worker.test.mjs", "we:scripts/operations/__tests__/dispatch-lane-routing-record.test.mjs", "we:skills-src/conveyor/fix-agent-brief.md", "we:skills-src/conveyor/fix-agent-ci-brief.md", "we:skills-src/conveyor/prepare-scope-agent-brief.md", "we:scripts/operations/__tests__/dispatch-lane-fixture-harness.test.mjs", "we:scripts/conveyor/__tests__/fix-executor-routing.test.mjs", "we:vitest.config.ts", "we:vitest.integration.config.ts", "we:scripts/operations/probation-heal-run.mjs", "we:scripts/operations/__tests__/probation-heal-run.test.mjs", "we:skills-src/conveyor/prepare-item-agent-brief.md", "we:__tests__/vitest.config.test.ts", "we:__tests__/vitest.integration.config.test.ts"]
dateOpened: "2026-10-12"
preparedDate: "2026-10-13"
preparedAgainstSha: "0e775583c82195ebb8d81cd4f241e83b2e6d8e7e"
tags: []
---

# Dispatcher leases the lane and hands it to fix/ci-heal/prepare workers; review jobs never lease a PR own lane

Reserve the actual worker checkout before launching a fresh fix, CI-heal, scope-prepare, or prepare-item worker, and hand that lease to the worker without a second allocation. Read-only reviews must use a free checkout other than the PR's own lane. Historical motivation: held finding 224 (coroner-5) reported 52 lane-already-leased events across 61 of 254 sessions during October 9–10, including jobs cf57089e, 872b486d, ad057938, 095515ac, 5506fbff and CI-heal session 001f51be. Those counts are incident evidence supplied with this card, not re-measured during preparation. Related #5439 supplies the build-reservation precedent.

## Design

1. Extend the reservation boundary in `we:scripts/operations/dispatch-lane-io.mjs:1353` to fresh fix, ci-heal, prepare and prepare-item launches; preserve the existing build switch and behavior. The `WE_DISPATCH_RESERVE_LANE` switch keeps gating build only; fresh fix, ci-heal, prepare and prepare-item reservation does not depend on it, and a payload missing its lane or session refuses instead of skipping reservation. Reserve after admission/claim checks but before any worker process starts. Share this mechanism with the separate fix launcher in `we:scripts/conveyor/reconcile-fix-dispatch.mjs:1307`. A free-list result is only a candidate: actual acquire must win before spawn. A busy candidate produces a bounded, retryable no-lane refusal, never a worker started to discover contention.
2. Carry a structured handoff containing repository/pool identity, canonical lane number/path, lease session, generation identity (`acquiredAt` plus `holder`), expected base ref and acquired HEAD SHA. Reuse the existing identity tuple compared by `sameLease` at `we:scripts/lane-pool.mjs:3700`; there is no existing numeric generation field. Return this data from the successful acquire, rather than reconstructing it from a later unguarded read. Repair reservation uses the PR head ref; prepare uses its existing base and card-only scope; prepare-item uses fresh fetched `origin/main` and card-only scope, as required at `we:scripts/lane-pool.mjs:1972` and `we:skills-src/conveyor/prepare-item-agent-brief.md:104`. Dispatch reservation means an ordinary lease, never the pool's permanent `--reserve` mode. A repair launcher must compare the reserved HEAD with the PR head it reads before work; a changed head defers without resetting the adopted lane or taking another. Thread the repair base through `we:scripts/operations/ci-heal-pr-dispatch.mjs:280` into the sink. Preserve current scope derivation, including the existing empty-scope CI-heal behavior; do not broaden authorizations. Source, documentation, configuration and data paths receive the same lease protection.
3. Extend adoption in `we:scripts/lane-pool.mjs:4314` with expected lease identity validation and a race-safe check/update coordinated with release/reclaim. Existing adoption checks liveness and occupant but does not authenticate the expected dispatch lease. Handoff adoption must reject stale, replaced, wrong-repository or wrong-session leases; never force a takeover. Preserve the original holder and release identity. The worker declares its own durable occupant, not the dispatcher's session. Re-adoption of the same handoff is idempotent and must not reset checkout contents.
4. Update the four active brief templates in scope (fix, CI-heal, prepare-scope and prepare-item) to consume a supplied handoff and adopt before edits. Retain explicit standalone acquisition when no handoff was supplied; a malformed supplied handoff must not fall back to acquiring another lane. Update the briefing contract in `we:scripts/operations/dispatch-lane.mjs` and test real template expansion. The Codex fix path must forward the handoff through `we:scripts/operations/dispatch-providers/fix.mjs` to `we:scripts/operations/fix-run.mjs:493`. The probation provider maps `prepare-item` to `we:scripts/operations/probation-build-run.mjs:329` and `ci-heal` to the live `we:scripts/operations/probation-heal-run.mjs:328`; both must accept the handoff and use the same acquired lane before starting the sandbox worker. The latter is distinct from the absent legacy mechanical CI-heal runtime. Keep launchers responsible for lease operations where sandbox workers cannot perform them. Pass a versioned, validated handoff as one JSON argv value to launchers and as a shell-quoted argument in agent briefs. Validate before any edits or reset. The shared sink currently receives an already-filled prompt: add the handoff only after reservation, using the same validated brief-expansion contract in both dispatchers; do not leave a placeholder in a launched prompt.
5. Release only the exact reservation on a provably pre-launch failure. Cover every operation after acquire, including the new post-reservation prompt expansion and scratch-cwd creation (the latter currently sits outside the provider catch at `we:scripts/operations/dispatch-lane-io.mjs:1535-1564`). Conditional release validates the full expected tuple under the same mutation coordination as adoption, release and reclaim, not just the reusable session slug. Once launch may have happened, retain the lease and report the indeterminate handle for existing reconciliation; never free a potentially occupied lane. Successful wrappers retain their existing terminal cleanup responsibilities. A resume uses its already owned checkout and allocates no new lane. Keep PR dispatch claims distinct from checkout leases.
6. Remove the preferred-lane-first behavior in `we:scripts/operations/review-job.mjs:694`. Resolve the PR's own lane identity from existing PR/lane metadata and exclude it from auto-selection, rather than merely dropping the preference (auto-pick could select that same lane). Add an exclusion option to the pool's acquire selection and apply it on every retry/growth selection. Scope the exclusion to its repository/pool. If an own-lane identity is supplied but invalid or its lookup fails, defer rather than silently ignore it. If the PR has no local mapped checkout, ordinary auto-pick is valid. Preserve job-slot and bounded-wait protections. `preferLane` is a free candidate assigned by the daemon (`we:skills-src/conveyor/review-daemon.mjs:417`, `we:skills-src/conveyor/review-daemon.mjs:477`), not the PR-own lane identity: never reinterpret that value as ownership. Add an injected own-lane lookup in the review IO boundary, backed by PR attribution and repository-scoped local lane/session metadata; distinguish a successful no-mapping result from an unreadable or ambiguous result. Keep the existing caller argument accepted but do not acquire it preferentially. Permanent own-lane exclusions must survive the retry loop's `excluded.clear()` calls at `we:scripts/lane-pool.mjs:2298` and `we:scripts/lane-pool.mjs:2323`.

7. Harden the authoritative ownership reads before any acquire/adopt mutation. `readLease` at `we:scripts/lane-pool.mjs:761-772` currently accepts incomplete objects and collapses corrupt/unreadable records into no lease. Distinguish absence from invalid evidence and refuse the latter before the acquire reaper or reset can act. A cached free list is only a hint; a candidate still needs complete authoritative lease evidence and an atomic claim. Inject truncated cache/state data in tests and require refusal for that dispatch attempt, without globally redefining unrelated status/reporting behavior.

## MVP

**Must:** Deliver one lease lifecycle across the active fresh Claude fix/CI-heal/prepare/prepare-item routes, the Codex fix route, and probation prepare-item/CI-heal routes: admission → acquire → launch → adopt/use → terminal release. Include the review exclusion and failure cleanup in the same change. Do not ship a path that reserves one checkout and subsequently allocates another. Keep the unavailable legacy mechanical prepare/CI-heal runtimes unavailable; their restoration is separate work, not a prerequisite. The existing build reservation is a regression case, not a new rollout decision. Deliver pool identity/exclusion first, then both dispatch boundaries, all active consumers and briefs, and finally route/proof coverage in one coordinated change so no intermediate route reserves one lane and acquires another. **Could / follow-up:** restore legacy runtimes only under their own graduation work and measure incident-rate changes after comparable live observation.

## Acceptance

- [A1] The two queued test commands below (integration tier, then unit tier) name every test file in the Test plan, each under the vitest config that owns it, and both must pass after implementation. Vitest treats each path as a filter and silently drops a path that matches nothing, so a green exit alone is not enough. A1 fails if any named file is missing from the run output, any test named in the Test plan is absent, or any named test is skipped, marked todo, or runs zero cases. Every newly added contention, handoff and truncation case must fail against the current implementation, unless the current code already rejects that shape; such a case is recorded in Progress as a non-regression pin, with its pre-change output.
- [A2] Must refuse before spawn on contention or invalid handoff; no force-taking, foreign release, or silent second acquisition.
- [A3] Must apply identical ownership checks to source, docs, configuration and data scopes, including empty-scope CI-heal without inventing a scope.
- [A4] Review auto-selection must exclude the PR's own lane even when that lane is free; resumed fixes must consume zero additional lanes.
- [A5] Definite spawn failure releases the matching reservation; an uncertain spawn retains it and remains observable.
- [A6] Truncated or incomplete pool state, lease records and supplied handoff data fail closed. Acquire, adopt and dispatch refuse; no free lane is guessed; no fallback acquisition, takeover or release happens; existing lease generation, holder, occupant and checkout contents stay unchanged. The four `truncated` tests mapped below enforce this.

## Test plan

Use hermetic temporary repositories and injectable launchers; never exercise the workstation pool in unit tests. Matching tests are included alongside every source entry in scope; brief coverage belongs to `we:scripts/operations/__tests__/dispatch-lane-fixture-harness.test.mjs`.

Every test below is named in backticks. A1 checks each name in each file listed for it. Planned files are marked; every other file already exists and is extended.

**Pool — integration tier.** Both planned pool files use real temporary git repositories and spawned `we:scripts/lane-pool.mjs` contenders, like their `we:scripts/__tests__/lane-pool*.test.mjs` siblings. So each joins the `include` list of `we:vitest.integration.config.ts` and the `exclude` list of `we:vitest.config.ts`, and runs in the first A1 command below.

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

**Dispatch boundary — unit tier.** Add each of these to `we:scripts/operations/__tests__/dispatch-lane-io.test.mjs`, `we:scripts/conveyor/__tests__/reconcile-fix-dispatch.test.mjs` and `we:scripts/operations/__tests__/ci-heal-pr-dispatch.test.mjs`, for every fresh fix, CI-heal, prepare and prepare-item route that file reaches (the separate fix dispatcher covers fix; CI-heal dispatch covers CI-heal; the shared sink covers its fresh routes):

- `acquire precedes every fresh spawn`
- `busy candidate gives a bounded retryable no-lane refusal and zero spawn`
- `reservation carries the correct repository, base, scope and lease identity`
- `applies identical lease checks to source, docs, config and data scopes` — at reservation.
- `fresh routes reserve with WE_DISPATCH_RESERVE_LANE unset` — fix, CI-heal, prepare and prepare-item reserve whatever that flag says. A payload missing its lane or session refuses before spawn and never returns a silent `reserved:false` that lets launch go ahead.
- `resume acquires no lane`
- `definite spawn failure releases the reservation exactly once` — include scratch-cwd, prompt-expansion and provider-validation failures after acquire.
- `uncertain spawn retains the reservation and reports its handle`
- `dispatcher exit before adoption leaves the lease held, not freed`
- `retry cannot release a replacement lease`
- `truncated reservation data refuses dispatch before spawn` — inject each pool-state/lease-record failure shape above through the reservation boundary; assert zero child starts, no guessed free lane or second acquisition, and no release or mutation of an existing lease.
- `untrusted refs and scopes reach acquire and launch as separate argv values` — values containing quotes, newlines, a leading `--` or `..`.

In `we:scripts/operations/__tests__/ci-heal-pr-dispatch.test.mjs` only, also add `empty-scope CI-heal is leased without inventing a scope`: the reservation and handoff carry the existing empty scope unchanged and pass the same ownership checks as a scoped route.

In `we:scripts/operations/__tests__/dispatch-lane-io.test.mjs`, next to the existing `reserveBuildLane` tests, add `build reservation keeps its WE_DISPATCH_RESERVE_LANE behavior` (the regression case the MVP names). The existing assertion there that a `prepare` launch returns `reserved:false` must change to expect a reservation.

In `we:scripts/conveyor/__tests__/fix-executor-routing.test.mjs`, add `routed CI-heal launches only after its lane reservation succeeds`. Its existing routed CI-heal case stubs `reserveLane` to return `reserved:false` and still expects one spawn; change that stub to a real reservation, and assert a refused reservation gives zero spawns.

**Review — unit tier.** In `we:scripts/operations/__tests__/review-job.test.mjs`:

- `auto-selection excludes the PR's own lane when it is free`
- `auto-selection excludes the PR's own lane when it is occupied`
- `invalid or failed own-lane lookup defers instead of ignoring it` — include a malformed CLI value before normalization and ambiguous local attribution.
- `daemon preferred candidate is not mistaken for the PR-own lane` — identify ownership independently; a different free candidate must not become the excluded lane.
- `no local mapping uses ordinary auto-pick`
- `full pool defers within the bounded wait and keeps job-slot limits`

**Workers and providers — unit tier.**

- In `we:scripts/operations/__tests__/fix-run.test.mjs`, `we:scripts/operations/__tests__/probation-build-run.test.mjs` and `we:scripts/operations/__tests__/probation-heal-run.test.mjs`:
  - `uses the supplied handoff lane and acquires no second checkout`
  - `standalone invocation without a handoff still acquires its own lane`
  - `truncated supplied handoff refuses launch or adoption without standalone fallback` — cover each truncation/read-failure shape above, including valid JSON missing repository/pool, lane, session/generation/holder or expected-base fields; assert refusal before launcher spawn or worker edits, zero fallback acquisition, and unchanged lease ownership/occupancy.
  - `definite launch failure releases the handed-off lease once and uncertain launch retains it`
  - In `we:scripts/operations/__tests__/fix-run.test.mjs` and `we:scripts/operations/__tests__/probation-heal-run.test.mjs`: `changed PR head refuses the handoff without reset or reacquire`.
  - In `we:scripts/operations/__tests__/probation-build-run.test.mjs` only: `prepare-item handoff preserves the origin/main base and card-only scope`.
- In `we:scripts/operations/dispatch-providers/__tests__/fix.test.mjs` and `we:scripts/operations/dispatch-providers/__tests__/probation-worker.test.mjs` (both planned, not existing suites; probation covers its prepare-item and CI-heal branches with injected launch and attempt hooks):
  - `forwards the handoff to the launcher argv`
  - `refuses a malformed handoff before spawn`
  - `standalone invocation is unchanged`
  - `truncated supplied handoff refuses launch or adoption without standalone fallback`
  - `untrusted refs and scopes reach acquire and launch as separate argv values`
- In `we:scripts/operations/__tests__/dispatch-provider-registry.test.mjs`: `prepare and CI-heal keep their default mode and forward the handoff` and `missing legacy mechanical runtimes are not restored`. Verify default agent routing and probation selection separately; the live probation healer is not an absent runtime.
- In `we:scripts/operations/__tests__/dispatch-lane-routing-record.test.mjs`: `routing record carries the lease identity end to end`.

**Briefs — unit tier.** In `we:scripts/operations/__tests__/dispatch-lane.test.mjs` and `we:scripts/operations/__tests__/dispatch-lane-fixture-harness.test.mjs`, using real template expansion of the four briefs:

- `filled briefs adopt the supplied handoff before any edit`
- `filled briefs acquire standalone only when no handoff is supplied`
- `handoff values are filled into brief commands as single quoted arguments`
- `applies identical lease checks to source, docs, config and data scopes` — one case per scope kind.
- In `we:scripts/operations/__tests__/dispatch-lane-fixture-harness.test.mjs` only: `truncated supplied handoff refuses launch or adoption without standalone fallback`.

**Config ownership — unit tier.** Add planned `we:__tests__/vitest.config.test.ts` with `unit config collects handoff config tests and excludes real-pool suites`, and planned `we:__tests__/vitest.integration.config.test.ts` with `integration config collects both real-pool handoff suites`. Inspect the exported configs without running subprocesses. Add these two exact test paths to the unit include list: its current entries at `we:vitest.config.ts:123-162` do not collect root-level tests. Assert the two planned pool files belong to integration only and that both new config tests are themselves collected.

Guarantee → enforcing tests (all files are in the A1 commands below):

| guarantee | named tests |
| --- | --- |
| A2 refuse on contention/invalid handoff | `two contenders…`, `busy candidate…`, `adopt accepts only the expected…`, `refuses a malformed handoff…`, `fresh routes reserve with WE_DISPATCH_RESERVE_LANE unset` |
| A3 identical checks per scope kind; empty-scope CI-heal | `applies identical lease checks…` (reservation, adoption, briefs), `empty-scope CI-heal…` |
| A4 review excludes own lane; resume takes no lane | `auto-selection excludes the PR's own lane…` (free, occupied), `resume acquires no lane`, `uses the supplied handoff lane…` |
| A5 definite failure releases, uncertain retains and is observable | `definite spawn failure…`, `uncertain spawn retains…reports its handle`, `definite launch failure…` (fix-run, probation build and heal) |
| A6 / edge 2 truncated data fails closed | `rejects truncated pool state…`, `rejects truncated lease records…`, `truncated reservation data…`, `truncated supplied handoff…` |
| Edge 1 untrusted text | `untrusted refs and scopes…`, `handoff values are filled into brief commands as single quoted arguments` |
| Edge 3 shared state | `two contenders…`, `adopt refuses a lease replaced between read and update`, `retry cannot release a replacement lease` |
| Edge 4 fail closed | `refuses a malformed handoff…`, `uncertain spawn retains…`, `invalid or failed own-lane lookup defers…` |
| Edge 5 identity scoping | `adopt accepts only the expected…`, `acquire never selects an excluded lane` (pool-scoped) |
| Edge 6 state over time | `resume acquires no lane`, `dispatcher exit before adoption…`, `re-adopting the same handoff is idempotent…` |
| Edge 7 holder vs occupant | `worker occupant is recorded apart from the dispatcher holder…` |
| Build regression; routed CI-heal | `build reservation keeps its WE_DISPATCH_RESERVE_LANE behavior`, `routed CI-heal launches only after its lane reservation succeeds` |

Run affected tests only through the host queue (WE checkout-relative CLI arguments). These commands are the A1 gate. Between them they name every test file in this Test plan, each under the config that owns it:

```bash
# Run from the WE checkout; strip only the repository prefix at the CLI boundary.
we_queue=we:scripts/readiness/heavy-admission.mjs
we_integration_config=we:vitest.integration.config.ts
we_unit_config=we:vitest.config.ts
we_integration_tests=(
  we:scripts/__tests__/lane-pool-dispatch-handoff.test.mjs
  we:scripts/__tests__/lane-pool-truncated-state.test.mjs
)
we_unit_tests=(
  we:scripts/conveyor/__tests__/fix-executor-routing.test.mjs
  we:scripts/operations/__tests__/dispatch-lane-io.test.mjs
  we:scripts/conveyor/__tests__/reconcile-fix-dispatch.test.mjs
  we:scripts/operations/__tests__/ci-heal-pr-dispatch.test.mjs
  we:scripts/operations/__tests__/review-job.test.mjs
  we:scripts/operations/__tests__/fix-run.test.mjs
  we:scripts/operations/__tests__/probation-build-run.test.mjs
  we:scripts/operations/__tests__/probation-heal-run.test.mjs
  we:scripts/operations/dispatch-providers/__tests__/fix.test.mjs
  we:scripts/operations/dispatch-providers/__tests__/probation-worker.test.mjs
  we:scripts/operations/__tests__/dispatch-provider-registry.test.mjs
  we:scripts/operations/__tests__/dispatch-lane-routing-record.test.mjs
  we:scripts/operations/__tests__/dispatch-lane.test.mjs
  we:scripts/operations/__tests__/dispatch-lane-fixture-harness.test.mjs
  we:__tests__/vitest.config.test.ts
  we:__tests__/vitest.integration.config.test.ts
)
node "${we_queue#we:}" run -- npx vitest run --config "${we_integration_config#we:}" "${we_integration_tests[@]#we:}"
node "${we_queue#we:}" run -- npx vitest run --config "${we_unit_config#we:}" "${we_unit_tests[@]#we:}"
node "${we_queue#we:}" run -- npm run check:standards
```

Check the run output against A1: all 18 files appear (2 in the integration run, 16 in the unit run), and every named test above ran and passed in each file listed for it. Any other test file the implementation touches also runs through the same queue; it adds to this command and never replaces it.

## Proof plan

Add explicit negative tests in an isolated disposable pool for truncated pool state, lease records and handoff data: cut each payload mid-record and at a syntactically valid boundary that omits required ownership fields; also simulate a bounded read that returns only a prefix and a read error reported as empty data. Exercise each supported fresh dispatch route through the dispatcher/launcher boundary and worker adoption where applicable. Assert dispatch/adoption is refused, no child starts on refused dispatch or edits a checkout after refused adoption, no free-lane fallback or takeover occurs, and existing lease generations, ownership and occupancy remain unchanged. Record each injected payload/read failure and the observed rejection; these tests must pass before graduation.

Before graduation, use an isolated disposable pool and controlled child workers through the real dispatcher/launcher boundary. Pause each fresh worker after dispatch acquisition, attempt competing acquisition, then let the worker adopt. Record the lease generation, repository, lane path, worker identity, child start time and pool journal: exactly one lease must span dispatch and work, the competitor must fail, and the child must edit only that checkout. Repeat for fix, CI-heal, prepare-scope, prepare-item, Codex fix, probation prepare-item and probation CI-heal; use the real `we:scripts/operations/probation-heal-run.mjs` boundary for the latter. For prepare-item, record the fetched main SHA and the one-card scope. For repairs, record the reserved PR SHA and exercise a head change before adoption. Run a read-only review while the PR-own lane is free and prove it selects another lane. Inject definite launch failure, uncertain launch acknowledgement and dispatcher exit between acquisition and adoption; observe cleanup or retained/reconciled occupancy without displacing a live worker. Record commands and observed output in this card at implementation time. Preparation itself does not claim these probes have passed.

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

- Legacy mechanical prepare/CI-heal graduation must consume this handoff if those absent runtimes return; do not recreate their stale provider comments as implementation here.
- Compare post-delivery contention outcomes with the historical finding only after collecting a comparable observation window; unit success alone does not establish an incident-rate improvement.

## Progress

- Preparation inspection: original scope named only `we:scripts/lane-pool.mjs`, `we:scripts/operations/review-job.mjs` and `we:scripts/conveyor/reconcile-fix-dispatch.mjs`, with no tests. Original premise treated workers uniformly as acquiring a named lane and reviews as already falling back to auto-pick.
- Corrected premise: `we:scripts/operations/dispatch-lane-io.mjs:1353-1366` already reserves builds only, gated by an environment flag; `we:scripts/operations/dispatch-lane-io.mjs:1535` is the shared pre-spawn hook. The separate fix path still documents free-list selection without reservation at `we:scripts/conveyor/reconcile-fix-dispatch.mjs:25-41` and launches at `we:scripts/conveyor/reconcile-fix-dispatch.mjs:1307` (`dispatchFix`). CI-heal reaches the shared sink at `we:scripts/operations/ci-heal-pr-dispatch.mjs:280`. These observations establish remaining work, not an already-delivered goal.
- Review drift: `we:scripts/operations/review-job.mjs:694-699` first tries a preferred lane, then auto-picks. Merely removing that preference does not enforce the title's exclusion. Current adoption at `we:scripts/lane-pool.mjs:4314-4333` lacks expected-dispatch-lease validation and directly rewrites the marker, so handoff identity and race tests are required.
- Worker topology drift: `we:scripts/operations/fix-run.mjs:493-500` independently acquires and later releases a lane; `we:scripts/operations/probation-build-run.mjs:329` also acquires. `we:scripts/operations/dispatch-provider-registry.mjs:99-134` defaults prepare/CI-heal to agent mode. The provider-referenced `we:scripts/operations/prepare-scope-run.mjs` and `we:scripts/operations/ci-heal-run.mjs` are absent in this checkout; their comments cannot establish a live runtime. Active acquisition instructions are at `we:skills-src/conveyor/fix-agent-brief.md:123`, `we:skills-src/conveyor/fix-agent-ci-brief.md:128` and `we:skills-src/conveyor/prepare-scope-agent-brief.md:62`.
- Prior preparation corrected scope to add shared dispatch, CI-heal payload plumbing, worker/provider consumers and the then-listed three briefs, with matching existing tests or permitted pool/review/fix test patterns. Size changes **3 → 8**: approximately 150–220 changed lines in pool ownership/exclusion, 180–260 across shared/separate dispatch and payload plumbing, 100–160 across worker/provider consumers, 40–70 in review selection, 40–70 in briefs, and 300–450 in associated tests (roughly 810–1,230 total). This is a story, so no `estimatedLoc` is added. The source boundaries above support the larger estimate.
- No dependency change proposed. Preparation edits only this card; runner-owned stamping, gates and review remain pending. Historical incidents were not replayed and implementation tests were not run for this documentation-only preparation.
- Prepare-validation repair: the previous scope paired provider sources only with broader registry/routing tests; it omitted matching provider-local test paths. Add planned `we:scripts/operations/dispatch-providers/__tests__/fix.test.mjs` and `we:scripts/operations/dispatch-providers/__tests__/probation-worker.test.mjs` to scope and the test plan. Evidence: argv construction and spawn at `we:scripts/operations/dispatch-providers/fix.mjs:105-131` and `we:scripts/operations/dispatch-providers/probation-worker.mjs:136-169` provide injectable boundaries for direct handoff tests. Neither planned suite exists yet. The implementation scope and size **8** remain unchanged; the provider suites allocate coverage already included in the associated-test estimate above.
- Review repair (PR 5140, round 3): the truncated-data tests were named but their files were missing from the A1 command, so a passing A1 run never executed them. Every Test-plan file is now named exactly (no globs) and listed in the A1 command; new files are marked planned. A1 now fails on a missing file, absent test or zero-case run. [A6] states the truncated-data guarantee. Every planned test is now named, and a guarantee → test table maps A2–A6, all seven edge cases and the build regression to named tests. The two new pool files are integration tier, so A1 runs them under `we:vitest.integration.config.ts` (both configs and `we:scripts/conveyor/__tests__/fix-executor-routing.test.mjs`, whose routed CI-heal case stubs `reserved:false` and still spawns, join scope). Design point 1 now states that `WE_DISPATCH_RESERVE_LANE` gates build only, and a payload missing its lane or session refuses.

- Current-lane re-preparation: the incoming card already had size **8** and a broad scope, but treated probation prepare and CI-heal as one consumer, omitted the live healer, and named only three active briefs. Corrected topology: `we:scripts/operations/dispatch-providers/probation-worker.mjs:46-50` routes `prepare-item` to the build runner and CI-heal to the live heal runner; `we:scripts/operations/probation-heal-run.mjs:328` independently acquires, with real IO at `we:scripts/operations/probation-heal-run.mjs:477-484`. Add that launcher and its existing test, plus `we:skills-src/conveyor/prepare-item-agent-brief.md:104`. The missing legacy mechanical scripts remain absent; no restoration is required to deliver the original goal. No delivering commit is claimed.
- Current-lane scope correction: the incoming scope included both Vitest configs without matching config tests. Add planned `we:__tests__/vitest.config.test.ts` and `we:__tests__/vitest.integration.config.test.ts`; explicitly collect them in `we:vitest.config.ts:123-162`, since root-level test files currently match no unit include. The A1 manifest now names 18 files, including the existing probation-heal suite and these two planned config suites. The four briefs share fixture-harness coverage. All source/config entries now have matching existing or planned tests in scope.
- Current-lane premise corrections: `we:skills-src/conveyor/review-daemon.mjs:417` obtains free candidates and `we:skills-src/conveyor/review-daemon.mjs:477` passes one as `preferLane`; it is not PR-own-lane metadata. Own-lane lookup therefore belongs in the review IO boundary, with an explicit no-mapping/error distinction. `we:scripts/lane-pool.mjs:3700` identifies a generation by acquiredAt/session/holder rather than a numeric generation field. `we:scripts/lane-pool.mjs:761-772` treats corrupt reads as no lease today; the negative tests must exercise that real mutation boundary. Updated the CI-heal sink citation to `we:scripts/operations/ci-heal-pr-dispatch.mjs:280`.
- Size remains **8 → 8** for this pass: the added healer mirrors the existing runner adoption work (about 40–70 source lines plus 60–90 tests); the fourth brief adds about 15–25 lines and 10–20 fixture lines; config collection and its two suites add about 40–60 lines. These extend the prior 810–1,230-line estimate to roughly 975–1,495 changed lines over the corrected touch set; the source boundaries above support retaining the same story size. No `estimatedLoc` is added to this story.
- Preparation evidence is read-only source inspection and card diff validation, not implementation proof. No lane acquisition, worker launch, test run, stamp, status transition, dependency edit, commit or publication was performed. Existing prepared metadata is preserved for the runner to replace after its checks; the implementation proof plan remains pending.
