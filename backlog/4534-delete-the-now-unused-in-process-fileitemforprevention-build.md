---
bornAs: xwtj36n
kind: task
parent: "4075"
status: open
scope: ["we:scripts/operations/review-loop-cli.mjs", "we:scripts/operations/__tests__/review-loop-cli.test.mjs", "we:scripts/operations/file-held-cards.mjs", "we:scripts/operations/__tests__/file-held-cards.test.mjs"]
estimatedLoc: 240
dateOpened: "2026-09-29"
preparedDate: "2026-11-18"
preparedAgainstSha: "0a352384aeb4e89efbe57fbf54c2c7230bab7e00"
tags: []
---

# Delete the in-process prevention helpers from we:scripts/operations/review-loop-cli.mjs after migrating their remaining caller

The goal remains removal of `fileItemForPrevention`, `buildFileItemArgv`, and their dedicated review-loop tests. The helpers are no longer the review-loop default, but are not unused: held-card filing still calls them. Preserve that caller's local filing behavior while removing its dependency on the review-loop driver.

## Progress

- Original premise/scope: #4493 left two non-default injectable helpers, presumed unused outside their tests; source scope contained only `we:scripts/operations/review-loop-cli.mjs` and omitted its test file.
- Corrected premise: repo-wide exact-symbol search found the live dynamic import and call in `we:scripts/operations/file-held-cards.mjs:193-203`. Its production default remains `fileInCheckout` at `we:scripts/operations/file-held-cards.mjs:209`. The existing batch test at `we:scripts/operations/__tests__/file-held-cards.test.mjs:575-590` exercises this adapter with an injected operation runner. Deleting the exports alone breaks this caller.
- Corrected scope: migrate that adapter's existing operation invocation into its owning module, then remove the obsolete review-loop exports and dedicated tests. Include both matching test files. This preserves the original cleanup goal without changing filing policy or introducing a new shared abstraction.
- Source evidence: old helper/argv implementation at `we:scripts/operations/review-loop-cli.mjs:140-234`; dedicated test blocks at `we:scripts/operations/__tests__/review-loop-cli.test.mjs:838-864` and `we:scripts/operations/__tests__/review-loop-cli.test.mjs:986-1031`; detached default at `we:scripts/operations/review-loop-cli.mjs:584`. Other exact-symbol hits outside these modules/tests are historical commentary, including `we:scripts/lib/prevention-landing-job.mjs:11`, not executable consumers.
- Estimate previously absent; add `estimatedLoc: 240`: approximately 85 changed lines in `we:scripts/operations/review-loop-cli.mjs` (deletions/comment repair), 80 in `we:scripts/operations/__tests__/review-loop-cli.test.mjs`, 25 in `we:scripts/operations/file-held-cards.mjs`, and 50 in `we:scripts/operations/__tests__/file-held-cards.test.mjs`. Count deletions as changed lines. No size or dependency change is proposed.
- Preparation used source inspection and symbol searches; no runtime tests were run and no prepared stamp was set.

## Design

Make `fileInCheckout` in `we:scripts/operations/file-held-cards.mjs` directly resolve and invoke `file-item`, retaining its existing `(input, run = runOperationCli)` seam. Use the existing operation resolver and run-store primitives from `we:scripts/operations/run.mjs` and `we:scripts/operations/run-store.mjs`; retain lazy resolution if needed to avoid a registry import cycle. Build the small argv locally for this sole remaining consumer. Preserve title, kind, digest, queue, JSON mode, optional parent/size/scope, and `notDuplicateReason`; omit empty scope/size flags exactly as the current adapter does. Allocate a fresh file run store for each call and mint file-item run IDs. Return the operation result unchanged.

Then delete the two exports and their dedicated tests/imports from the review-loop source and suite. Rewrite nearby comments that describe a retained injectable binding or link to the deleted functions. Do not remove shared resolver/store imports still used by the review CLI. Historical commentary in other modules is not a live dependency and need not be rewritten.

Keep `runReviewLoopOnce` defaulting to `fileItemForPreventionViaLandingJob`; keep held-card filing defaulting to `fileInCheckout`. No persistence format, ledger policy, settings, or destination change. Nonzero/incomplete local filing results must still be refused without ledger entries, and landing-job spawn failure must still return a nonzero result.

## MVP

1. Add regression assertions for export removal and held-card independence from the review-loop module; observe them fail against the current implementation.
2. Move the remaining caller's invocation into `fileInCheckout`, with the same flags, store lifecycle, and result contract.
3. Remove the review-loop helpers and dedicated tests; retain detached-landing and batch/ledger coverage. Recheck all executable consumers before completing deletion.

## Acceptance

- [A1] **Executable** — add `obsolete in-process prevention exports are absent` in `we:scripts/operations/__tests__/review-loop-cli.test.mjs`, checking the module namespace lacks both exact exports. Run the queued command in Test plan. It fails on today's exports and passes after removal; the remaining suite must still pass, including the real-default detached-landing and spawn-refusal cases.
- [A2] **Executable** — add `files locally without loading the review-loop driver` in `we:scripts/operations/__tests__/file-held-cards.test.mjs`. In an isolated module context make loading the review-loop module throw, invoke `fileInCheckout` with the injected runner, and assert real declaration parsing, optional flag omission/preservation, duplicate reason, distinct stores, file-item run IDs, unchanged result, and no destination flags. Run the queued command below. It fails at today's dynamic import and passes after migration. Restore module mocks after the test.
- [A3] **Executable** — add `independent local filer leaves failed and incomplete results unledgered` in `we:scripts/operations/__tests__/file-held-cards.test.mjs`, using the same throwing review-loop module boundary and routing the batch through `fileInCheckout` with nonzero and malformed-success runner results. Assert refusal and no ledger row. Run the queued command below. The current dependency throws before these assertions; after migration the existing fail-closed behavior must satisfy them.

## Edge cases

Absent scope/size must not become literal undefined flags; empty parent is omitted. Duplicate explanations survive argv construction. Multiple calls do not share a store. Do not substitute the detached landing job for held-card filing: the existing batch contract expects immediate local card identities. No new bound or fallback is introduced.

## Test plan

Run only the two affected suites through the host queue. Repository prefixes below identify paths; shell expansion removes the prefix for execution:

```sh
queue=we:scripts/readiness/heavy-admission.mjs
review=we:scripts/operations/__tests__/review-loop-cli.test.mjs
held=we:scripts/operations/__tests__/file-held-cards.test.mjs
node "${queue#we:}" run -- npx vitest run "${review#we:}" "${held#we:}"
```

Use the new acceptance tests for red/green evidence, retaining the existing batch test and failed/incomplete-result tests. If admission is busy, use one queue-supported bounded wait, then stop and report; no polling. No live filing or external dispatch is needed.

## Proof plan

Capture the new tests failing before implementation and passing afterward, plus the complete affected-suite result. Search the repository for exact word-boundary occurrences of both deleted symbols and classify every remaining hit: historical prose is allowed; declarations, imports, calls, and the old dedicated describe blocks are not. The negative export regression may name the symbols as assertion strings. Verify the caller no longer imports the review-loop driver and inspect the final diff for unchanged defaults and ledger handling. A failed or unreadable search is incomplete evidence, not proof of absence. Runner-owned standards checks and stamping follow preparation; this card does not claim those checks have run.

## Follow-ups

None required for this bounded cleanup. If another executable consumer appears before build, migrate its existing behavior and update the touch set/test estimate before deletion; do not silently remove a used API or reroute a local filer into detached landing.
