---
bornAs: xx79w8n
kind: story
size: 5
parent: "4075"
status: open
scope: ["we:scripts/lib/pr-limit.mjs", "we:scripts/lib/__tests__/pr-limit.test.mjs", "we:scripts/readiness/dispatch-plan.mjs", "we:scripts/readiness/__tests__/dispatch-plan.test.mjs", "we:skills-src/conveyor/build-dispatch-daemon.mjs", "we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs", "we:scripts/lib/pr-snapshot.mjs", "we:scripts/lib/__tests__/pr-snapshot.test.mjs", "we:scripts/lib/pr-list-paged.mjs", "we:scripts/lib/__tests__/pr-list-paged.test.mjs", "we:scripts/lib/git-pr-commits.mjs", "we:scripts/lib/__tests__/git-pr-commits.test.mjs", "we:scripts/lib/__tests__/gh-cost-git-paths.test.mjs"]
dateOpened: "2026-10-02"
preparedDate: "2026-11-20"
preparedAgainstSha: "8635c7b7885f110641582eb15520a7e1ecb1f87d"
tags: []
---

# Prevention — complete PR-count cache and dispatch error regressions

Complete the remaining prevention from chalbert/web-everything#3215: invalidate authorship when the base changes, preserve primitive effect failures, and limit read-only scope collection to planning snapshots. Persisted failure cooldowns and the leading-PR starvation regression have already landed; retain them while changing cache identity.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3215@531fca7854e9f4c433d8d9d0ca7703f27cb7bfd8

## Design

Use a versioned authorship-cache identity containing repository, PR number, head OID, base ref name and base OID. Both successful verdicts and failure cooldowns belong to that identity. Missing base/head identity must not reuse a persisted verdict or failure marker; attempt a bounded fresh read and report unresolved when evidence is unavailable. Old head-only entries are misses and are pruned through the existing live-key flush. Preserve the three-API-read dispatch cap, fifteen-minute cooldown, per-call memoization and local-first behavior.

Carry baseRefOid through the direct list projection in we:scripts/lib/pr-limit.mjs and the shared producer in we:scripts/lib/pr-list-paged.mjs (field declaration, GraphQL selection and row mapping), then advertise it in we:scripts/lib/pr-snapshot.mjs. An old snapshot without the field cannot supply a reusable cache identity. Pass baseRefOid to we:scripts/lib/git-pr-commits.mjs and verify origin/main matches it before trusting the local range; stale/missing base evidence falls back to the existing bounded API path, or remains unresolved in local-only mode. Do not broaden local Git support beyond main-based PRs.

In we:scripts/readiness/dispatch-plan.mjs, append --no-track-attempts only when WE_PLANNING_SNAPSHOT_DIR is nonempty, using the exported environment constant from we:scripts/lib/planning-snapshot.mjs. Ordinary planning invokes the collector's existing tracking default; snapshot planning remains a pure read. The counter's owner is the collector's breachAttemptForLane/advanceBreachCount path in we:scripts/readiness/scope-lease-collect.mjs: it counts changed breach episodes, not polls. No new counter or persistence owner is introduced.

In we:skills-src/conveyor/build-dispatch-daemon.mjs, attach timings only when the thrown value is non-null and typeof object, then rethrow the original value. Preserve ordinary Error timing diagnostics and primitive rejection identity.

## MVP

Implement the cache identity and evidence plumbing, update historical head-only fixture keys explicitly, add the base-change regressions, condition scope-collector argv on the snapshot environment, and guard timing annotation. Keep the existing starvation tests as regression coverage; do not implement another scheduler or change PR-limit defaults, exclusions, retry intervals or admission policy.

## Done when

- [A1] Executable — Add `fixed head recomputes authorship after base retarget or base movement` in we:scripts/lib/__tests__/pr-limit.test.mjs: seed a human verdict, hold the head fixed, change the base name or OID and returned commits to AI, and require a new read and counted verdict. Cover the reverse verdict, unchanged identity reuse, old head-only persisted state, missing base identity and failure-marker invalidation. This fails against the current head-only key and passes after the change.
- [A2] Executable — Add `base identity reaches the local range verifier` across we:scripts/lib/__tests__/pr-list-paged.test.mjs, we:scripts/lib/__tests__/pr-snapshot.test.mjs and the planned we:scripts/lib/__tests__/git-pr-commits.test.mjs. Assert actual producer query/row projection includes baseRefOid; stale or absent local base evidence returns null rather than authorizing the wrong range. These new assertions fail on current producers/local guards and pass after plumbing. Extend we:scripts/lib/__tests__/pr-limit.test.mjs to prove missing base plus failed reads remains unresolved and never becomes a human verdict.
- [A3] Executable — Add `scope collection tracks only outside planning snapshots` in we:scripts/readiness/__tests__/dispatch-plan.test.mjs, exercising the real collector argv construction for absent, empty and nonempty snapshot environment values. Require default tracking in the first two and --no-track-attempts in the third. The ordinary-mode assertions fail before the change. Pin collector failures as failed planning, never an empty lease set; retain the admission tests that count unresolved PRs conservatively.
- [A4] Executable — Add `tick preserves primitive effect rejection and Error timings` in we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs. Throw a string, null and undefined from an injected effect reached by runBuildDispatchTick; assert exact rejection identity and no later dispatch. Also assert an Error retains identity and receives the timer snapshot. Primitive identity assertions fail before the guard and pass after it.

## Test plan

Run the seven scoped test files listed in scope through the host heavy-admission queue using its `run -- npx vitest run` command form; the executable entrypoint is we:scripts/readiness/heavy-admission.mjs. All file arguments are WE-relative paths obtained by removing the `we:` locus from the scoped test references. Create we:scripts/lib/__tests__/git-pr-commits.test.mjs for the direct base-OID match, mismatch and missing-evidence guards; retain and update the existing caller fixtures in we:scripts/lib/__tests__/gh-cost-git-paths.test.mjs so the stricter helper inputs preserve local success and API fallback. Use injected Git/GitHub effects and task-temporary cache files, with deterministic clocks and no live network.

Keep the existing persisted four-round starvation fixture in we:scripts/lib/__tests__/pr-limit.test.mjs: three failing leaders and four trailing PRs must still spend [3, 3, 1, 0] API reads, leave three unresolved, and resolve every trailing PR after cache reloads. Update its rows with complete base identity and its expected keys, without weakening bounds. Retain cooldown expiry, moved-head invalidation, local recovery and budget-exhaustion tests. Add negative/missing-base variants to the existing cap tests. Admission stays conservative for unreadable source, docs, config and data PRs; existing card-only exclusions are unchanged.

## Proof plan

First add A1–A4 tests and capture their intended assertion failures on the original implementation, then capture passing results after the scoped implementation. Run unchanged compatibility tests alongside them to prove cache migration did not remove starvation prevention or change caller refusal behavior. Record the exact queued command and results, including per-round API counts, in the delivery evidence. For the already-delivered starvation behavior, use its passing regression as preservation evidence rather than claiming it is a new red-to-green fix. The runner owns preparation stamping and gates; this preparation performs no runtime changes.

## Follow-ups

No new policy fork or dependency edge is required. Broader cache freshness across independently changing remote snapshots, fairness when persistent cache writes fail, and support for local non-main commit ranges are outside this prevention item. Do not silently claim those guarantees from the bounded cooldown test.

## Progress

- Original premise: all five review findings were outstanding, with citations at we:scripts/lib/pr-limit.mjs:194, we:scripts/lib/pr-limit.mjs:202, we:scripts/lib/pr-limit.mjs:232, we:scripts/readiness/dispatch-plan.mjs:938 and we:skills-src/conveyor/build-dispatch-daemon.mjs:222. Original scope was three sources and three tests; size was 3.
- Corrected premise: findings 1 and 5 were delivered by commit ad9ef3a8748 (`WE #4778: pr-limit: a PR whose commit read keeps failing must not star`). Current evidence: cooldown handling at we:scripts/lib/pr-limit.mjs:329–336 and the persisted four-round regression at we:scripts/lib/__tests__/pr-limit.test.mjs:585–602. The remaining cache key is head-only at we:scripts/lib/pr-limit.mjs:323–324; scope argv is unconditional at we:scripts/readiness/dispatch-plan.mjs:959; primitive annotation remains unguarded at we:skills-src/conveyor/build-dispatch-daemon.mjs:324. These are source observations, not claimed test executions.
- Corrected scope: include base evidence producers and local verification. we:scripts/lib/pr-limit.mjs:231 does not request baseRefOid; we:scripts/lib/pr-snapshot.mjs:55–59 does not advertise it; we:scripts/lib/pr-list-paged.mjs:30, we:scripts/lib/pr-list-paged.mjs:82 and we:scripts/lib/pr-list-paged.mjs:239 omit it from fields/query/mapping. we:scripts/lib/git-pr-commits.mjs:25–28 verifies only the head before reading the local range. Matching existing tests are explicitly included in scope.
- Scope-collector default evidence: we:scripts/readiness/scope-lease-collect.mjs:638–657 owns tracking and disables it only for --no-track-attempts; we:scripts/lib/planning-snapshot.mjs:13–17 caches only pure scope reads. The daemon supplies the snapshot environment at we:skills-src/conveyor/build-dispatch-daemon.mjs:1655. Existing PR-count callers remain conservative at we:scripts/readiness/dispatch-plan.mjs:284–286 and we:skills-src/conveyor/build-dispatch-daemon.mjs:2825–2826.
- Size changed from 3 to 5: six source files × approximately 5–30 changed lines plus six test files × approximately 20–80 changed lines, including persisted-key fixture migration and real producer coverage. The expanded cross-file identity path above supports this estimate. This is a story, so no estimatedLoc field is added. No stamps, claims or status changes made.

- Prepare-validation repair: the prior scope paired we:scripts/lib/git-pr-commits.mjs only with we:scripts/lib/__tests__/gh-cost-git-paths.test.mjs. That existing suite imports the helper at line 6 and covers its null-return guards at lines 87–106, but no dedicated matching test file exists. Add planned we:scripts/lib/__tests__/git-pr-commits.test.mjs to scope and A2 for base-identity guard coverage: we:scripts/lib/git-pr-commits.mjs:12–15 requires head/base-name evidence, while we:scripts/lib/git-pr-commits.mjs:25–28 verifies the head but not the base OID before reading the range. The corrected touch set is six source files × approximately 5–30 changed lines, six existing test files × approximately 20–80 changed lines, and one new helper test file × approximately 40–60 lines. Size remains 5; the original goal and completed preparation sections are preserved. No runtime tests were run for this card-only scope repair.
