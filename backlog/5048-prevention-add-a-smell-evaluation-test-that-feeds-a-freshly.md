---
bornAs: xejopmw
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/health-smells/review-label-missing.mjs", "we:scripts/conveyor/health-smells/__tests__/review-label-missing.test.mjs", "we:scripts/__tests__/review-set-label.test.mjs"]
dateOpened: "2026-10-04"
preparedDate: "2026-11-24"
preparedAgainstSha: "6cb241cd114142a184b3d4f536a007cd84a47d58"
tags: []
---

# Prevention — Add a smell-evaluation test that feeds a freshly opened draft with no labels through runHealthTic… (from web-everything/web-everything#3767 review)

Prevent normal draft creation from opening a missing-review-label health episode, and pin the guarantee that a refused missing-mode rearm does not consume a fix round.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#3767@4c0ec48c7faca02cab8a92dc845bb34018923d5e

## Progress

- Original premise/scope: add prevention tests beside the diagnostic at the former `we:scripts/conveyor/reconcile-core.mjs:1355` and missing-mode writer at the former `we:scripts/review-set-label.mjs:1367`, with both source files in scope.
- Corrected premise: the shared tri-state diagnostic is now `we:scripts/conveyor/reconcile-core.mjs:2226`; it deliberately reports draft label absence too. The caller test at `we:scripts/conveyor/__tests__/reconcile-core.test.mjs:4141` explicitly preserves that diagnostic without changing dispatch. The alert adapter at `we:scripts/conveyor/health-smells/review-label-missing.mjs:11` passes observations straight to that predicate. Its current test at `we:scripts/conveyor/health-smells/__tests__/review-label-missing.test.mjs:34` expects a draft to satisfy the predicate, and there is no draft-through-tick exclusion test. Fix alert eligibility in the adapter, preserving the shared diagnostic.
- Producer evidence: `we:scripts/conveyor/health-watch.mjs:867` builds review observations separately from the outer PR row; `we:scripts/conveyor/health-watch.mjs:879` supplies outer `isDraft`. Test that production shape rather than assuming the observation contains draft status.
- The pre-write missing-mode guard already runs at `we:scripts/review-set-label.mjs:2101`, before the ledger write. Refusal fixtures exist at `we:scripts/__tests__/review-set-label.test.mjs:3597` and `we:scripts/__tests__/review-set-label.test.mjs:3622`. The count assertion at `we:scripts/__tests__/review-set-label.test.mjs:3879` covers ordinary rollback, not missing-mode pre-write refusal. The counter uses trusted marker authors at `we:scripts/conveyor/rearm-review.mjs:74`.
- Corrected touch set: one smell adapter plus its matching test and the existing CLI test; no writer or shared-predicate change is needed. Keep size 3: approximately 10–20 adapter lines, 60–90 smell-test lines, and 30–50 CLI-test lines (100–160 changed lines across three files). This remains a story; no estimatedLoc field is added.
- Research was source inspection; no runtime pass is claimed. Stamping and checks remain runner-owned.

## Design

In `we:scripts/conveyor/health-smells/review-label-missing.mjs`, exclude rows whose outer `isDraft` is explicitly true from alert evaluation after the existing observation freshness checks. Do not modify `missingReviewLabel`: label absence remains useful diagnostic evidence even for drafts. Use an unknown/skipped observation for the excluded draft rather than inventing restored-label evidence; this item concerns preventing a new episode, not closing a previously open one when a PR becomes draft.

Preserve the adapter's existing handling of non-draft and legacy rows without an outer draft field, its two-fresh-sample opening threshold, cached/missing evidence handling, and alert-only action. No setting, default, marker format, review dispatch, or round-count policy changes.

For missing-mode refusal, extend the injected CLI harness in `we:scripts/__tests__/review-set-label.test.mjs:3183`. Supply a real countable marker body through buildComment and trusted authors when reconstructing the resulting thread. Begin with an existing counted round so an unchanged count cannot pass merely because the counter ignored every fixture. Compare the initial thread with initial comments plus captured posted bodies, and separately assert no label, comment, or ledger writes. Reuse the current guard rather than introducing another writer or marker family.

## MVP

1. Add a failing fresh-draft tick regression in `we:scripts/conveyor/health-smells/__tests__/review-label-missing.test.mjs`, then implement the adapter exclusion.
2. Add promotion, legacy-row, unknown-evidence and serialized-state controls to the same test group; retain the shared predicate's draft expectation.
3. Add the explicit count-preservation regression to the missing-mode CLI tests in `we:scripts/__tests__/review-set-label.test.mjs`, covering a refused second read after a valid initial read.

## Acceptance

- [A1] Executable — proposed test `5048-A1 fresh unlabeled draft never opens an episode` in `we:scripts/conveyor/health-smells/__tests__/review-label-missing.test.mjs`: feed an outer `isDraft: true` row with an OPEN, agent-authored, empty-label review observation through runHealthTick for at least three distinct fresh timestamps; serialize state between ticks. Assert no opened transition, open episode or alert action. With this test installed, current code must fail; the adapter change must pass.
- [A2] Executable — proposed test `5048-A2 promotion and legacy observations retain alert eligibility` in `we:scripts/conveyor/health-smells/__tests__/review-label-missing.test.mjs`: in the same lifecycle, first prove the draft exclusion, then set outer isDraft false and require exactly two fresh samples to open once. Include a legacy row without isDraft and retain the direct predicate assertion for drafts. This lifecycle assertion fails on the old adapter and passes after; existing non-draft and diagnostic controls must remain green.
- [A3] Executable — proposed test `5048-A3 unknown evidence cannot advance a draft lifecycle` in `we:scripts/conveyor/health-smells/__tests__/review-label-missing.test.mjs`: after proving draft exclusion, promote and interleave absent, stale, future and malformed observations between fresh valid samples. Unknown evidence must neither open nor falsely close an episode or count toward the opening streak. The draft portion fails before the fix; all controls pass afterward.
- [A4] Executable — proposed test `5048-A4 refused missing rearm preserves counted rounds` in `we:scripts/__tests__/review-set-label.test.mjs`: invoke the actual injected CLI with --only-if=missing and a pinned head, then refuse the fresh pre-write read using unreadable comments, a thrown paginated-thread read, and a changed head. Assert nonzero exit, unchanged count over the reconstructed thread, and empty comment, label and ledger writes. This is missing coverage of an already implemented guard: prove red by temporarily moving the missing-mode recheck after the comment write, then green after restoration; do not claim the unmodified production guard currently fails.

## Test plan

Run only the two scoped test files through the host heavy-admission queue using its run subcommand and npx vitest run with the selected paths. Resolve the visible we: repository prefixes to working-directory-relative arguments when invoking the commands. Use the existing injected provider and temporary-ledger harness; no GitHub or network operations. If admission is busy, wait once with the queue's supported wait option, then stop and report.

Also run the existing affected caller assertions in `we:scripts/conveyor/__tests__/reconcile-core.test.mjs` through the same queue to demonstrate that preserving the shared predicate leaves draft diagnostics and dispatch unchanged. Do not edit that file or weaken its draft expectation.

## Proof plan

Capture the A1–A3 regression failures with the new tests and old adapter, followed by passes with the exclusion. For A4 capture the deliberate ordering-mutation failure and restored-guard pass; label that evidence as mutation proof, not a newly discovered writer defect. Check that the count fixture has a nonzero baseline and that a trusted captured marker would increment it, so the counter assertion is sensitive to the original failure mode. Record targeted command outcomes and inspect the final diff for only the scoped implementation/test changes at build time. Preparation changes only this card; the runner owns preparation validation and stamping.

## Follow-ups

None required for this prevention slice. Changing the shared diagnostic, closing existing episodes on a transition back to draft, or defining a distinct missing-family marker would be separate behavior changes; neither is needed to meet the original two prevention guarantees.
