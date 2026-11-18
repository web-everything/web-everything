---
bornAs: xwtj36n
kind: task
parent: "4075"
status: open
scope: ["we:scripts/operations/review-loop-cli.mjs", "we:scripts/operations/__tests__/review-loop-cli.test.mjs", "we:scripts/operations/file-held-cards.mjs", "we:scripts/operations/__tests__/file-held-cards.test.mjs"]
estimatedLoc: 230
dateOpened: "2026-09-29"
preparedDate: "2026-11-18"
preparedAgainstSha: "0a352384aeb4e89efbe57fbf54c2c7230bab7e00"
tags: []
---

# Delete the in-process fileItemForPrevention/buildFileItemArgv exports from we:scripts/operations/review-loop-cli.mjs

The review-loop production default already uses `fileItemForPreventionViaLandingJob`. Remove its obsolete in-process exports and dedicated tests, after migrating the live held-card caller to own its existing checkout-local filing binding. This is dependency cleanup, not a change to where either operation files cards.

## Progress

- Original premise/scope: both helpers were unused outside their dedicated tests; only we:scripts/operations/review-loop-cli.mjs was scoped, with no matching test or line estimate.
- Corrected premise: repository-wide symbol search finds a live dynamic import and call in we:scripts/operations/file-held-cards.mjs:195-198. Its `fileInCheckout` is the default at we:scripts/operations/file-held-cards.mjs:209. Deleting the exports alone would break held-card filing. The review-loop default remains the detached landing binding at we:scripts/operations/review-loop-cli.mjs:584.
- Corrected scope: remove the exports from the review-loop module, move the necessary in-process operation wiring into the existing held-card binding, and update both matching suites. No new shared abstraction or change to filing policy is needed. The held-card contract is already pinned by we:scripts/operations/__tests__/file-held-cards.test.mjs:480 and :575 (omitted flags and one-checkout batch).
- Source evidence: implementation and documentation occupy we:scripts/operations/review-loop-cli.mjs:140-175 and :210-234; dedicated test blocks begin at we:scripts/operations/__tests__/review-loop-cli.test.mjs:838 and :986. Landing/default tests begin at :1038 and :1129 in that same test file. Other symbol hits are historical prose/comments, not additional runtime consumers.
- Estimate: previously absent; `estimatedLoc: 230` counts approximately 100 changed lines in we:scripts/operations/review-loop-cli.mjs (removals/import/comment cleanup), 90 in we:scripts/operations/__tests__/review-loop-cli.test.mjs (remove old blocks and add export-absence assertions), 20 in we:scripts/operations/file-held-cards.mjs (replace wrapper dependency), and 20 in we:scripts/operations/__tests__/file-held-cards.test.mjs (migration regressions). No size change or dependency-edge change is proposed.

## Design

Make `fileInCheckout` in we:scripts/operations/file-held-cards.mjs resolve and run the declared `file-item` operation directly, preserving its injected `run` argument. Resolve the operation lazily as today to avoid introducing an eager operation-table cycle. Create a fresh run store per call and retain `newRunId('file-item')`, declaration, registry, sinks, JSON output and result/error propagation.

Construct the existing argv locally: title, kind, digest, queue, JSON, optional nonempty scope/size/parent, and optional `notDuplicateReason`. Preserve missing scope/size omission, and never introduce destination or juror cwd flags. Reuse the existing operation resolver, CLI adapter and run-store utilities; do not duplicate the operation implementation.

After migrating that sole runtime caller, delete `fileItemForPrevention` and `buildFileItemArgv` from we:scripts/operations/review-loop-cli.mjs and their two dedicated describe blocks/imports in we:scripts/operations/__tests__/review-loop-cli.test.mjs. Remove only imports made unused by this deletion. Rewrite nearby current-tense documentation that links to deleted helpers; historical backlog references need no edits.

Keep the review-loop landing-job default, queued receipt handling and nonzero-filing refusal paths unchanged. No settings, persisted-state format or defaults change. Retain the existing landing/default/failure tests.

## MVP

1. Add migration tests to the two scoped suites before removing the helpers.
2. Replace the held-card binding's dynamic import of the review-loop with direct operation wiring, preserving all current caller semantics.
3. Delete the obsolete exports, dedicated tests and obsolete local references; retain coverage of the surviving in-process behavior in the held-card suite.
4. Verify symbol/import closure and run only the two affected suites through the host queue.

## Acceptance

- [A1] Executable — add `obsolete in-process helpers are not exported` in we:scripts/operations/__tests__/review-loop-cli.test.mjs, checking both properties are absent from the module namespace. It fails on the current exports and passes after deletion. Also inspect repository-wide exact-symbol matches to confirm no remaining executable consumers; historical text and the negative assertions are allowed.
- [A2] Executable — add `checkout filing works with the review-loop module unavailable` in we:scripts/operations/__tests__/file-held-cards.test.mjs using an isolated module mock that throws if the review-loop is imported. Drive `fileInCheckout` twice through its injected runner and assert real file-item declaration/registry/sinks, fresh stores, file-item run IDs, argv including optional fields and duplicate reason, and unchanged nonzero result propagation. The current dynamic import fails this test; the migrated binding passes. Retain the existing omitted-size/scope and same-checkout batch tests.
- [A3] Executable — run A1 together with the existing default-wiring, queued-payload and failed-spawn tests in we:scripts/operations/__tests__/review-loop-cli.test.mjs, including the filing-failure case at :445. This combined check fails before deletion through A1 and passes afterward only if the landing default and fail-closed behavior remain intact. Do not rewrite these existing assertions to accommodate a behavior change.

## Test plan

Run the affected suites from the WE root through the host heavy-run queue. The executable shell paths below strip the documented `we:` locus prefix:

```sh
queue=we:scripts/readiness/heavy-admission.mjs
review=we:scripts/operations/__tests__/review-loop-cli.test.mjs
held=we:scripts/operations/__tests__/file-held-cards.test.mjs
node "${queue#we:}" run -- npx vitest run "${review#we:}" "${held#we:}"
```

Capture the new tests failing on the pre-build implementation, then passing after migration/deletion. Existing behavior tests are preservation checks, not claims of a pre-existing behavioral bug. If admission is busy, use the queue's own bounded wait once, then report the result; do not poll or run tests outside admission.

## Proof plan

Before deletion, inspect repository-wide exact-symbol references (including dynamic imports and re-exports), separating executable callers from historical documentation. After migration, repeat that search and verify the only executable references are negative export assertions. Use word boundaries so the retained `fileItemForPreventionViaLandingJob` is not mistaken for the deleted symbol. Treat search/read errors as incomplete evidence, not zero matches.

Record the A1/A2 red-to-green results, the two-suite queue output, and retained default/failure test results. Inspect the final diff for unchanged landing-job wiring and preserved held-card argv/result behavior. The runner owns preparation stamping and checks; no live filing, commit, push or PR is part of this preparation.

## Follow-ups

None required for this cleanup. Detached-job durability and daemon soak coverage are separate work; do not expand this card into those behavior changes.
