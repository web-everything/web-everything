---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/__tests__/review-tick-promote.test.mjs", "we:skills-src/conveyor/review-daemon.mjs", "we:scripts/operations/promote-draft-pr-dispatch.mjs", "we:scripts/operations/__tests__/promote-draft-pr-dispatch.test.mjs"]
dateOpened: "2026-10-21"
tags: []
---

# Prevention: enforce review executor bindings and guarded stale-accept refusals

PR #5793 advisory prevention: require production-binding assertions for every optional executor of we:skills-src/conveyor/review-daemon.mjs#runReviewTick, including promoteDrafts, rearmStaleAccepts, and noteRearms. The repair adds these assertions and refuses malformed planned heads. Once the stale-accept provider from #5628 is available, exercise its real fresh-read and coverage decisions with mocked external IO: a still-covered live head and a row another executor already rearmed must both refuse with zero label mutations. Add a standards check or parameter-to-wiring-test inventory so newly added optional executors cannot silently omit production coverage. Local filing only: queue clearance is deferred to the launcher because this sandbox permits only lane file writes.

## Acceptance

- [A1] Add a standards check or executable inventory pairing each optional executor accepted by `we:skills-src/conveyor/review-daemon.mjs#runReviewTick` with a production-binding assertion. Preserve the assertions added for `promoteDrafts`, `rearmStaleAccepts`, and `noteRearms` in PR #5793. A missing or renamed binding must fail the wiring test.
- [A2] After the provider from PR #5628 is present, add a named regression using the real `defaultRearmStaleAcceptance` with mocked external reads and writes: fresh live acceptance covering the head refuses and performs zero label mutations. Assert the fresh read occurred; do not mock the provider itself.
- [A3] Add a named provider regression where the planned row is stale because another executor already rearmed the PR. Assert fresh state is read, refusal is returned, and zero label mutations occur. Include an accepted-to-pending transition between planning and execution.
- [A4] Required CI selects the wiring and provider regressions. Use `npm run test:unit --` to run `we:scripts/conveyor/__tests__/review-tick-promote.test.mjs` and `we:scripts/operations/__tests__/promote-draft-pr-dispatch.test.mjs`, plus the affected standards check. The provider cases must fail if their refusal checks are reverted by the authorized verification harness.

## Dependency

The checkout reviewed for PR #5793 does not export `defaultRearmStaleAcceptance` from `we:scripts/operations/promote-draft-pr-dispatch.mjs`. Provider regressions require the implementation from PR #5628; they must exercise that implementation rather than recreate its guards in the wrapper. PR #5793 already tests the unavailable-provider refusal.

## Non-goals

- [N1] Change acceptance policy, perform live label writes, or replace the existing guarded provider.

## Edge cases this change must handle

1. **Untrusted text** — Keep invalid and missing head SHA cases from PR #5793; no malformed head reaches a writer.
2. **Truncated reads** — Provider read errors or incomplete coverage evidence must refuse with zero writes.
3. **Shared state files** — n/a: tests use mocked external IO and no shared state files.
4. **Fail closed** — Unavailable provider, missing bindings, and uncertain live coverage must remain visible refusals or test failures.
5. **Identity scoping** — Assert exact repository, PR number, and head SHA arguments through the production binding.
6. **State over time** — Re-read after planning; defend both fresh coverage and concurrent rearm by another executor.
7. **Who wrote it** — Preserve existing actor and invariant checks; fixtures must not grant write authority through labels alone.
