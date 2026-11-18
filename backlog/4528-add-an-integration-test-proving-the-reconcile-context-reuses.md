---
bornAs: xejvuqt
kind: task
parent: "4108"
status: open
blockedBy: ["4108"]
scope: ["we:scripts/__tests__/merge-ai-prs-reused-context-couple.test.mjs"]
estimatedLoc: 180
dateOpened: "2026-09-29"
preparedDate: "2026-11-18"
preparedAgainstSha: "e2bed0a8c3b86ff61617d318f55efeda18ff5b21"
tags: []
---

# Add an integration test proving the RECONCILE context reuses raw, base- and label-unfiltered candidate-listing rows

Prove the raw-listing reuse seam preserves a manifest-carrying carrier excluded from merge candidates, and that its coupled implementation cannot bypass the carrier's hold or open dependency. This is test coverage of existing behavior, not a change to merge policy.

## Design

Add `we:scripts/__tests__/merge-ai-prs-reused-context-couple.test.mjs`. Compose the exported production functions from `we:scripts/merge-ai-prs.mjs`: candidate filtering, `buildLiveListingsByRepo`, `collectOpenPrContext`, and `planDrainPass` (which calls `buildCarrierHealth` and `joinImplToCouples`). Use `filterOpenPrsByLabel` from `we:scripts/lib/no-search-backed-pr-list.mjs` and `filterOpenPrsByBase` to derive candidate `prs` from raw `rows`; never construct the expected context directly.

Use local-WE and FUI repo keys consistently, with a carrier manifest describing both lane refs and a manifest-less, otherwise mergeable AI implementation PR. Inject per-PR manifest/commit reads using the established shapes in `we:scripts/__tests__/merge-ai-prs-couple-join-and-drain-verdicts.test.mjs:29-58`. The injected `listOpenPrs` returns the real reuse map's entry; `fetchReads` supplies reads only for the rows it receives. Pass filtered listings and the resulting context to `planDrainPass`, with the same repo keys, label and read map. Do not mock the join, health reduction or plan.

Use two independently discriminating cases:

- Cross-base carrier: base `develop`, ready-to-merge label plus `review:pending`, with a sweep selecting `main`. The base filter alone removes the carrier; context retains it, the implementation joins its item and defers with `coupleDeferReason: held`.
- Literally unlabelled carrier: base `main`, `labels: []`, manifest with an open `blockedBy` item. Include another raw PR whose manifest names that blocker. The label filter alone removes the carrier; context retains both items, the implementation inherits the dependency and is deferred by the drain plan. Lack of a ready label alone is not a hold.

Add a degraded-read variant retaining the carrier's valid manifest but setting its read's `degraded: true`; assert incomplete context and an implementation defer with reason `degraded`. Add a healthy control with no hold or dependency: a filtered-out but healthy carrier remains visible and the implementation can be ready. This guards against tests that pass because all fixtures are inherently unmergeable.

## MVP

One new integration test file, using injected IO and production composition. Cover separate base-only and label-only exclusions, the degraded-read path and healthy control. Assert context identity, join identity and final ready/deferred membership rather than just listing counts. No production exports, defaults, callers or persisted-state formats change. Existing CLI tests retain responsibility for gh argv and per-pass call counts.

## Acceptance

The following command is executable from the WE checkout. The shell removes the repository prefixes from the two declared paths before invoking Node; retain the prefixes in this card's references.

```sh
QUEUE=we:scripts/readiness/heavy-admission.mjs
TEST=we:scripts/__tests__/merge-ai-prs-reused-context-couple.test.mjs
node "${QUEUE#we:}" run -- npx vitest run "${TEST#we:}"
```

- [A1] Executable — the command above runs the named `cross-base held carrier remains visible and defers its implementation` test: candidate rows exclude the carrier, `prsByRepo` includes it, `openItems` includes its item, the implementation joins that item, reports `held`, appears in `plan.deferred` and not `plan.ready`.
- [A2] Executable — the same command runs `unlabelled carrier preserves its open dependency`: carrier has zero labels and the selected base; context retains carrier and blocker items, the implementation inherits the carrier's item and blockedBy edge, and is deferred rather than orphan-ready.
- [A3] Executable — the same command runs `degraded reused carrier read fails closed`: the valid manifest remains indexable, context completeness is false, and the joined implementation reports `degraded` and is absent from ready.
- [A4] Executable — the same command runs `healthy excluded carrier permits its implementation`: a complete context retains the healthy carrier and the joined implementation is ready, proving exclusion itself is not a new hold policy.

Each named test is new: before implementation the exact-file command exits nonzero because the file does not exist; after implementation it must pass without `--passWithNoTests`. This is a coverage addition to working production behavior, not a claim that current production fails these scenarios.

## Test plan

Build fixtures using the existing couple suite's mergeable AI commit and manifest shapes. Keep the two exclusions separate so a missing base filter cannot be masked by the label filter. Assert candidate exclusion before exercising context reuse. Verify the callback receives the excluded carrier, then assert the actual context maps and production plan outputs. Bound fixture size below the listing cap; the degraded variant explicitly changes only the read evidence. No real GitHub calls, subprocess CLI harness or filesystem state is needed.

Run the Acceptance command through the host queue. Also run the affected neighboring suites through that queue: `we:scripts/__tests__/merge-ai-prs-listing-dedupe.test.mjs` and `we:scripts/__tests__/merge-ai-prs-couple-join-and-drain-verdicts.test.mjs`. Use the same prefix-stripping shell pattern for their file arguments. If admission is busy, use its supported bounded wait once and report the result; do not poll.

## Proof plan

Record the exact-file pre-build nonzero result and post-build passing test names/counts. For regression sensitivity during build, temporarily change the reuse-map selection from raw `rows` to filtered `prs` in `we:scripts/merge-ai-prs.mjs:2523`; rerun the new file and require A1/A2 to fail on carrier visibility or join assertions, then restore the source and rerun green. This temporary probe must leave no production diff. Capture the final test-only diff and neighboring-suite results. The runner owns preparation checks and stamping; no test execution or mutation probe is claimed by this preparation.

## Follow-ups

Full fake-gh CLI coverage of the carrier manifest API read is optional separate work; this task exercises the exported reuse-to-plan integration and existing CLI coverage already checks candidate filtering and listing reuse counts. No new merge-policy decisions or default changes are needed.

## Progress

- Original premise: the #4108 tests only checked list-call counts and candidate filters, with production-only scope `we:scripts/merge-ai-prs.mjs` and no effort estimate. Corrected premise: `we:scripts/__tests__/merge-ai-prs-listing-dedupe.test.mjs:68-120` already tests reused-row truncation and raw-versus-filtered map selection. The missing coverage is their composition with carrier reads and the couple drain plan. A search of existing tests finds reuse-map assertions there and a snapshot exclusion assertion in `we:scripts/__tests__/merge-ai-prs.test.mjs:218`, not this combined scenario.
- Source evidence: the production collector consumes injected listing/read callbacks at `we:scripts/merge-ai-prs.mjs:2210-2222`; the live wrapper reuses rows at `we:scripts/merge-ai-prs.mjs:5314`; the sweep constructs the map at `we:scripts/merge-ai-prs.mjs:5788`. The production plan computes health and invokes the join at `we:scripts/merge-ai-prs.mjs:2649-2673`. The existing couple suite constructs context separately through its reducer at `we:scripts/__tests__/merge-ai-prs-couple-join-and-drain-verdicts.test.mjs:45-58`, so it does not close the reuse-map integration gap.
- Factual correction: carrier visibility or exclusion alone does not require deferral. `we:scripts/merge-ai-prs.mjs:2030-2040` permits a healthy carrier; `we:scripts/merge-ai-prs.mjs:2093` derives held status from review labels. Therefore the cross-base case needs an explicit review hold and the zero-label case an open inherited dependency. The join inherits identity and dependency edges at `we:scripts/merge-ai-prs.mjs:1712-1717`.
- Corrected scope is one new test file, `we:scripts/__tests__/merge-ai-prs-reused-context-couple.test.mjs`; production code is reference material, not an intended shipping edit. Added `estimatedLoc: 180`: one file × approximately 60 lines of imports/fixtures, 45 lines of shared collection/planning setup and 75 lines of four cases/assertions. No size existed or was changed. All other frontmatter, including blockedBy, is preserved. Preparation is based on source inspection; the runner owns stamps and checks.
