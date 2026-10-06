---
bornAs: x9mr5is
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/reconcile-pass.mjs", "we:scripts/conveyor/__tests__/reconcile-pass.test.mjs"]
dateOpened: "2026-10-02"
preparedDate: "2026-10-06"
preparedAgainstSha: "15bec18134cc3a5150ef20b708bf1b289c2bbcf5"
tags: []
---

# The disjoint-closure check treats a deleted dependency as touching the failing test

Follow-up from the #3559 advisory (2026-10-02). A deleted source dependency can change extensionless import resolution while the head-only impact walk still declares a failing test untouched. Conservatively refuse timeout-rerun eligibility for source deletions until base-versus-head resolution can be proved unchanged.

## Progress

- Preparation inspection: the old premise cited `we:scripts/conveyor/reconcile-pass.mjs:1257` for the deletion/fallback hole. The relevant code now lives in `timeoutImpact` at `we:scripts/conveyor/reconcile-pass.mjs:1359`; it flattens filenames and previous filenames without considering status at line 1361, then chooses the first existing head candidate at lines 1415–1418. The collector retains GitHub file records at lines 1504–1508 and supplies only head-tree blobs at lines 1549–1568. Thus the premise remains supported by source inspection, not an executed regression: a removed preferred candidate is absent from the head map and an unchanged fallback can make the walk return null.
- Old scope: `we:scripts/conveyor/reconcile-pass.mjs` and `we:scripts/conveyor/__tests__/reconcile-pass.test.mjs`. Corrected scope: the same two files; this is a local impact-classification guard, not a resolver rewrite or collector redesign. The matching test exists: classifier fixture at `we:scripts/conveyor/__tests__/reconcile-pass.test.mjs:803`, immutable-reader integration at line 899. Existing missing-dependency coverage at line 860 has no fallback; rename coverage at line 845 leaves the old target in the source map and therefore does not cover a vanished old candidate.
- Current behavior also includes a backlog-card-only exception at `we:scripts/conveyor/reconcile-pass.mjs:1362–1374`, covered by `we:scripts/conveyor/__tests__/reconcile-pass.test.mjs:1195`. Preserve that exception; ordinary documentation, configuration, data and fixture changes already refuse.
- Size remains 2: one bounded guard in `we:scripts/conveyor/reconcile-pass.mjs:1359` and extensions of existing classifier/reader tests in `we:scripts/conveyor/__tests__/reconcile-pass.test.mjs:803` and line 899. No new interface, network read, persistence format or dependency is needed. Preparation performed source inspection only; runner owns stamps, checks and independent review.

## Design

In `timeoutImpact` in `we:scripts/conveyor/reconcile-pass.mjs`, inspect the original changed-file records before traversing roots. A GitHub `status: removed` record whose filename matches the existing source-extension predicate must return a non-null refusal, even when no head closure reaches that filename. Use the diagnostic `deleted-source-impact-unknown` (proposed). A `status: renamed` record with a source `previous_filename` must receive the same conservative treatment: moving away the old candidate has the same resolution hazard. Keep the existing previous-filename intersection check for other records.

Use the existing source-extension definition, covering JS/TS and its current module/JSX variants. Do not fetch base blobs or infer safety from the presence of a fallback. Preserve head binding and all existing unknown-input checks. A deletion of an apparently unrelated source is deliberately refused too: this is the conservative behavior requested by the original card, not a claim that every deletion really affects every test. Backlog-card-only changes retain their current behavior.

The collector already passes through GitHub status and previous filename in `we:scripts/conveyor/reconcile-pass.mjs:1504–1508`; no input shape change is required. `classifyTimeoutEvidence` already converts a non-null impact reason into `{ eligible: false, reason }` at `we:scripts/conveyor/reconcile-pass.mjs:1452–1453`. Its enrichment and planner consumers need no changes. The independent infra-cancelled branch at `we:scripts/conveyor/reconcile-pass.mjs:1537–1544` remains outside this timeout-failure rule.

## MVP

1. **Must 1 — deletion refusal:** refuse source removals and source rename-away records before accepting a disjoint head closure, including an unchanged resolution fallback and an apparently unrelated removal.
2. **Must 2 — fail closed:** retain refusals for incomplete or stale evidence, unresolved imports, parsing errors and unknown dependency edges; do not convert errors into eligibility.
3. **Must 3 — preserve other input handling:** ordinary documentation, config, data and fixture changes remain cautious/refused, including deletions. Preserve the existing backlog-card-only exception and eligible disjoint source additions/modifications.
4. **Must 4 — prove the production evidence path:** demonstrate with injected GitHub responses that removed/renamed status reaches classification and prevents timeout-rerun eligibility without requiring base-tree reads.

Deliver as one implementation change plus regressions in the two declared scope files. No resolver redesign, rerun-budget changes or live CI mutation belongs in this MVP.

## Test plan

Extend `we:scripts/conveyor/__tests__/reconcile-pass.test.mjs`:

- Start with the complete, head-bound timeout fixture at line 803. Make the test import an extensionless subject; omit the preferred TS source from the head map, retain an unchanged JS fallback, and mark the TS source removed in the changed records. Assert the explicit deletion refusal. Repeat with an index fallback and with a renamed old source path absent at head.
- Add an unrelated source deletion and a mixed card/source deletion. Both refuse. Exercise the current source-extension family with table cases rather than widening it silently.
- Pair these with disjoint `added` and `modified` source records that remain eligible, and retain existing direct-dependency, unresolved-import and unknown-edge tests. Include a source deletion with no fallback; its result must still be ineligible.
- Preserve the ordinary docs/config/data/fixture refusal matrix at line 821 and the backlog-card-only cases at line 1195, including removed non-source inputs and a removed backlog card.
- Adapt the injected reader fixture at line 899 to return realistic removed and renamed records plus only head blobs. Assert `readTimeoutEvidence` returns ineligible and enrichment/planning produces no `ci-timeout-rerun` dispatch. The reader mock must reject unexpected API requests, proving no new base-source reads.

## Done when

1. **Musts 1 and 4:** the fallback regression fails against the original implementation (it incorrectly returns eligible) and passes with the guard; the reader/planner regression proves no timeout-rerun dispatch for the same deletion evidence.
2. **Musts 2 and 3:** the full scoped test file passes with all existing fail-closed and card-only behavior retained and positive disjoint additions/modifications still eligible.
3. Run the scoped test and standards gate through the host heavy-run queue as described below, recording actual outcomes rather than treating this preparation as executed proof.

## Proof plan

During implementation, add the deletion/fallback regression first and run it through the queue to capture the expected red result. Add the guard, rerun the full scoped suite, then run the standards gate. From the WE root, use `node` with `we:scripts/readiness/heavy-admission.mjs`, arguments `run -- npx vitest run` and the test operand `we:scripts/conveyor/__tests__/reconcile-pass.test.mjs` (strip the `we:` repository notation when executing). For the standards gate, use the same queue entry with `run -- npm run check:standards`.

Keep proof deterministic and read-only: mocked immutable GitHub responses exercise the real reader, classifier, enrichment and planner, without requesting an actual CI rerun. Record the before/after eligibility and absence of a timeout-rerun dispatch. This establishes the deletion guard's behavior, not equivalence between the static resolver and every runtime resolver.

## Follow-ups

A future relaxation may compare base and head resolution before allowing source deletions or rename-away changes. That requires its own scope and evidence for candidate order, setup roots and unknown edges; it is not required here. This item does not broaden the existing resolver's extension/alias support or revisit the backlog-card-only policy. No blockedBy changes are proposed.
