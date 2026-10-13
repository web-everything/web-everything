---
bornAs: x8ake8p
kind: story
size: 1
parent: "4075"
status: open
scope: ["we:scripts/conveyor/__tests__/lease-reaper.test.mjs"]
dateOpened: "2026-09-28"
preparedDate: "2026-10-12"
preparedAgainstSha: "4b20b067f5e38ab4b6d58828bd1d183f7a68ac25"
tags: []
---

# File the prevention guard(s) owed by chalbert/web-everything#2836's independent review

Complete the remaining prevention obligation from the approved review: assert that the real-git merge fixture contains unique resolution content on the lane and lacks it upstream before testing containment. The second obligation, required backlog classification validation, already exists under the current `kind` schema.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#2836@37cf210525ce939539419ae6e2b294d43f854906

## Progress

- **Old premise/scope:** mechanically filed against we:backlog/4337-lease-reaper-branch-fallback-reject-lanes-with-unlanded-merg.md:24 and we:backlog/4315-a-confirmed-broken-impact-advisory-finding-must-not-be-ignor.md:2, requesting fixture preconditions and a validator requiring `workItem`. Those card citations were provenance, not implementation locations; the second also pointed to the debt in we:backlog/4319-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md.
- **Corrected premise:** the fixture in we:scripts/conveyor/__tests__/lease-reaper.test.mjs:1294 writes unique content at line 1321 but asserts only patch equivalence and unaccounted merge reachability at lines 1334–1341 before checking containment at line 1345. It does not read and assert the two committed file contents. The production merge veto already exists at we:scripts/conveyor/lease-reaper.mjs:511; this item requires no production change.
- **Schema evidence:** we:scripts/check-standards-rules.mjs:224 documents replacement of `type`/`workItem` with `kind`; required-field validation at line 375 includes `kind`. The live gate invokes that validator for each backlog item at we:scripts/check-standards.mjs:851, and we:scripts/__tests__/check-standards-frontmatter-parse.test.mjs:23 pins missing-kind rejection. Do not reintroduce a retired field or duplicate this guard. This is source inspection, not a claim that the suite was run during preparation.
- **Corrected scope and sizing:** replace the two historical card paths with the existing matching test file, we:scripts/conveyor/__tests__/lease-reaper.test.mjs. No source entry requires an additional test path because the entire touch set is this regression suite. Change size **3 → 1**: one file × approximately 8–12 changed lines for two committed-blob reads, exact assertions, and an explanatory comment, grounded in the setup/assertion boundary at lines 1332–1345. Keep `kind: story`; no task-only estimate field.
- **Preparation boundary:** only this card is edited; implementation, execution proof, and runner-owned checks/stamping remain outstanding.

## Design

Strengthen the existing unique-resolution case in we:scripts/conveyor/__tests__/lease-reaper.test.mjs:1294. After both commit IDs are captured and the lane is checked out again, use the existing real-git helper to read the committed conflict-file blob at `laneHead` and at `landedSha`. Assert exact lane content `other-v\nresolved-unique-content\n` and exact upstream content `other-v\n`. Use commit-addressed `git show` reads, not working-tree reads, so the assertions establish the histories supplied to containment. Keep the existing cherry, merge-reachability, and final false-containment checks.

The fixture deliberately amends a clean merge to model merge-only resolution content; do not describe it as an actual conflicted merge or change that construction. The conservative production veto also rejects content-free merges, so the final false result alone cannot establish this fixture's unique-content premise.

## MVP

1. Add the two committed-blob reads and exact expectations before the existing containment checks in we:scripts/conveyor/__tests__/lease-reaper.test.mjs.
2. Explain that these assertions prevent fixture drift from turning the unique-resolution regression into another content-free-merge test.
3. Preserve the existing production behavior and all neighboring real-git cases. No schema changes are needed for the already-covered second obligation.

## Test plan

- Run the complete existing suite in we:scripts/conveyor/__tests__/lease-reaper.test.mjs through the host heavy-run queue; this covers the strengthened case plus literal merge, patch-equivalent squash/rebase, and content-free merge compatibility.
- Temporarily remove the unique marker from the fixture's amended blob: the new lane-content assertion must fail before containment is called. Restore it.
- Temporarily include the marker in the landed fixture's blob: the upstream-content assertion must fail before containment is called. Restore it. Keep mutations isolated and retain neither in the final diff.
- Run the existing required-kind regression in we:scripts/__tests__/check-standards-frontmatter-parse.test.mjs as evidence for the narrowed schema obligation.

## Proof plan

The correct fixture should pass both before and after adding assertions; a normal-suite red-before claim would be misleading for this test-hardening change. Demonstrate the missing guard by applying each content mutation separately to the original fixture: its merge-existence veto can still yield false containment without proving unique content. Apply the same mutations with the new assertions and record the specific content-expectation failures. Restore the fixture and record a passing complete suite.

Run executable commands from the WE repository root; repository prefixes belong to prose references, not shell arguments:

```bash
node scripts/readiness/heavy-admission.mjs run -- npx vitest run scripts/conveyor/__tests__/lease-reaper.test.mjs
node scripts/readiness/heavy-admission.mjs run -- npx vitest run scripts/__tests__/check-standards-frontmatter-parse.test.mjs
node scripts/readiness/heavy-admission.mjs run -- npm run check:standards
```

Record command results and mutation outcomes during implementation. The runner owns preparation checks and stamping.

## Follow-ups

No additional blocker is required. The independent executable-command guard and review-habit obligations in we:backlog/4319-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md remain with that item; they are not imported here. If that card is later prepared, reconcile its retired `workItem` wording against the same current validator evidence.

## Done when

The two committed-content assertions are present ahead of containment in we:scripts/conveyor/__tests__/lease-reaper.test.mjs, both deliberate content mutations fail at those assertions, the restored full suite passes, and the queued standards gate passes. The existing required-kind regression provides evidence that the second prevention obligation needs no duplicate implementation.
