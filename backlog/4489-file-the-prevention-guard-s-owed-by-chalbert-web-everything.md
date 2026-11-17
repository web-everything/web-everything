---
bornAs: xlqhu1t
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/run-rating.mjs", "we:scripts/conveyor/__tests__/run-rating.test.mjs"]
dateOpened: "2026-09-29"
preparedDate: "2026-11-17"
preparedAgainstSha: "6dd6c4b691a0764b265999aace3610cf72d2d795"
tags: []
---

# File the prevention guard(s) owed by chalbert/web-everything#2942's independent review

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/run-rating.mjs:1293` — Make the resolver tri-state: true, false when a card is found without preparedDate, and null or undefined when the card is unresolvable. Add a test that the comparison excludes unresolvable rows. A review-lens note is enough: any 'absence of evidence' default that feeds a bucketed report needs an explicit unknown bucket.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#2942@fa846b1e164dddf31dec1588135fbde7c924a774

## Progress

- Current re-preparation: incoming scope was the resolver source and its matching test; it remains correct. Incoming citations placed the resolver at `we:scripts/conveyor/run-rating.mjs:1282`, reader at `we:scripts/conveyor/run-rating.mjs:1240`, comparison at `we:scripts/conveyor/run-rating.mjs:1365`, and legacy/CLI tests at `we:scripts/conveyor/__tests__/run-rating.test.mjs:1097` / `we:scripts/conveyor/__tests__/run-rating.test.mjs:1133`. Current source inspection locates those at `we:scripts/conveyor/run-rating.mjs:1293`, `we:scripts/conveyor/run-rating.mjs:1251`, `we:scripts/conveyor/run-rating.mjs:1376`, and `we:scripts/conveyor/__tests__/run-rating.test.mjs:1119` / `we:scripts/conveyor/__tests__/run-rating.test.mjs:1151`. The false fallback is still present at `we:scripts/conveyor/run-rating.mjs:1295`; the goal remains undelivered. Updated the active citations and executable acceptance below. Size remains 3 (old 3 → new 3): approximately 15–25 changed source lines for the fallback and contract comments, plus 90–130 test lines for the matrix, real resolver integration, and isolated CLI fixture. No dependency change or unresolved policy fork was found. This is a story, so no estimatedLoc field is added.
- Original premise/scope: the approval owed a tri-state resolver and an exclusion regression in `we:scripts/conveyor/run-rating.mjs` and `we:scripts/conveyor/__tests__/run-rating.test.mjs`; its resolver citation was `we:scripts/conveyor/run-rating.mjs:1288`.
- Corrected premise: the resolver now starts at `we:scripts/conveyor/run-rating.mjs:1293` and still returns `false` when the shared card reader returns `null`. The reader at `we:scripts/conveyor/run-rating.mjs:1251` already distinguishes unreadable/unresolvable content from a readable card. The comparison at `we:scripts/conveyor/run-rating.mjs:1376` already uses strict boolean buckets and excludes both `null` and `undefined`; the missing work is producing unknown status and proving its propagation, not inventing a new comparison algorithm.
- Scope remains the two existing files above, with the source paired to its matching test file. Existing tests at `we:scripts/conveyor/__tests__/run-rating.test.mjs:1042` and `we:scripts/conveyor/__tests__/run-rating.test.mjs:1074` explicitly require the incorrect false fallback; the legacy-undefined exclusion test at `we:scripts/conveyor/__tests__/run-rating.test.mjs:1119` does not exercise unresolved lookup.
- Prior preparation recorded this runtime observation (not rerun during this preparation): importing the real module and passing a no-item fix rating through `preparedForItem(null)`, `toScorecardRow`, and `preparedComparison` produced resolver/row values of `false` and an unprepared count of 1, with its wall time, rework round, and D grade included. The goal is not already delivered.
- Consumer evidence: `toScorecardRow` at `we:scripts/conveyor/run-rating.mjs:1080` passes resolver output through unchanged; `buildReport` at `we:scripts/conveyor/run-rating.mjs:1759` consumes the strict comparison. The store's `appendScorecard` contract at `we:scripts/conveyor/run-scorecard-store.mjs:329` preserves extra fields. Recording callers in `we:scripts/conveyor/session-reaper.mjs` and `we:scripts/operations/review-job.mjs`, and the backfill caller in `we:scripts/conveyor/backfill-2026-09-27-run-rating-slice1.mjs`, do not directly interpret preparation status. No edits to those consumers are required; persistence and CLI behavior will be exercised through the existing rating test file.

## Design

Use `null` as the explicit, JSON-stable unknown state. Keep `preparedForItem(itemOrPr, { repoRoot })` and its non-throwing behavior: return `null` when the shared reader cannot resolve/read a card, `false` for a readable card with absent, empty, or whitespace-only `preparedDate`, and `true` for a non-empty string stamp. Update the resolver JSDoc to `boolean|null` and explain the distinction before changing the implementation. Keep the existing numeric lookup and score-time interpretation of readiness.

`toScorecardRow` must preserve the resolver result without truthiness coercion. Keep `preparedComparison`'s existing strict boolean filters: explicit unknown (`null`) and legacy missing status (`undefined`) enter neither comparison cohort. Update its commentary to cover both unknown cases. The unknown category is represented explicitly in stored rows; this item requires exclusion, not an additional public report table or changed report shape.

Existing persisted `false` rows cannot be distinguished retrospectively as known-unprepared versus lookup-failed. Leave them unchanged; this fix governs newly scored rows and does not claim to repair historical measurements. No schema version bump or migration is needed because preparation status is an extra field passed through by the store.

Review-lens prevention note: when absence of evidence feeds a bucketed report, inspect the producer as well as the filter. Require a distinct unknown state and verify that it cannot silently join a known-negative cohort.

## MVP

1. **Must 1:** Document and implement the tri-state resolver in `we:scripts/conveyor/run-rating.mjs`, preserving readable-card behavior and non-throwing lookup failures.
2. **Must 2:** In `we:scripts/conveyor/__tests__/run-rating.test.mjs`, replace the two false-for-unresolvable expectations and add real filesystem resolver-to-row-to-comparison regressions. Preserve existing true/false and legacy-undefined coverage.
3. **Must 3:** Extend the existing temporary-store CLI report test in `we:scripts/conveyor/__tests__/run-rating.test.mjs` with a real unresolved row carrying `prepared: null`, and verify JSON/text comparisons exclude it after serialization. Update source comments and retain the review-lens note above.

Deliver these together as one small change: changing the resolver alone would contradict existing tests. Size 3 remains appropriate for one localized behavior change plus filesystem, persistence, and CLI regression coverage.

## Test plan

All new/changed cases belong in `we:scripts/conveyor/__tests__/run-rating.test.mjs`, matching the scoped source `we:scripts/conveyor/run-rating.mjs`.

- Resolver matrix: stamped readable card → true; absent/empty/whitespace stamp → false; null item, hash-only ID, missing numeric card, missing backlog directory, and failed card read → null without throwing. Make the read-failure fixture deterministic (a dangling symlink named like a matching card), avoiding permission-mode assumptions.
- Row wiring: injected null remains null; the default resolver produces null from an actual missing card. Include a readable unstamped card to prove false remains a meaningful known result.
- Mixed comparison: generate prepared, unprepared, and unresolved rows through the real resolver with temporary cards. Give unknown rows conspicuous wall time, tokens, rework kinds, and grades. Compare both complete summaries against the known-only baseline, not just counts. Retain a missing-field legacy row and an all-unknown case yielding empty summaries.
- Persistence/CLI: extend the existing isolated report fixture, preserving its migration stamps and empty coverage roots. Serialize a real unresolved scorecard row and confirm null survives JSON storage. JSON and text report counts/averages must equal the known-only baseline, while overall report row count still includes unknown rows.

## Proof plan

At implementation time, run the focused regression cases before changing the resolver and retain their expected failures: current code must fail the null-status and unknown-exclusion assertions. After the change, run the same cases and the full scoped suite. Temporarily restoring only the resolver's false fallback must make the new end-to-end regression fail again; remove that mutation before delivery.

Executable suite: use `we:scripts/readiness/heavy-admission.mjs` with arguments `run -- npx vitest run` followed by the WE-relative path for `we:scripts/conveyor/__tests__/run-rating.test.mjs` (strip the `we:` locus prefix only when passing the argument). For delivery, use the same queue entrypoint with arguments `run -- npm run check:standards`. Run all focused, full-suite, and mutation checks through that queue. The existing CLI subprocess test supplies the runtime proof with isolated state; never backfill or modify the production scorecard store to demonstrate this fix. These are implementation proof requirements, not claims that the future tests were run during preparation; the prior preparation probe is recorded in Progress. This re-preparation verified source and test contents; the runner owns preparation checks and stamping.

## Acceptance

The following are planned test names in `we:scripts/conveyor/__tests__/run-rating.test.mjs`. Run each through `we:scripts/readiness/heavy-admission.mjs` with arguments `run -- npx vitest run`, the WE-relative test path (remove only its `we:` prefix for execution), and `-t` followed by the quoted test name. Each test must fail against the current resolver and pass after the implementation; preserved behavior is asserted alongside the changed default in the same test.

- [A1] Executable: `tri-state resolver distinguishes readable cards from unresolved lookups` — real filesystem matrix asserts true for a nonempty stamp, false for absent/empty/whitespace stamps, and null without throwing for null ID, hash ID, missing numeric card, missing directory, and dangling matching symlink. This proves the changed default and every reader failure path closes comparison admission rather than asserting known-unprepared.
- [A2] Executable: `real resolver rows exclude unknown status from both complete summaries` — exercise the default caller in `toScorecardRow`, plus injected null propagation; combine real stamped, unstamped, and unresolved rows, and a legacy missing-field row. Assert null survives scoring, historical explicit false stays in the unprepared cohort, both complete summaries equal the known-only baseline, and an all-unknown population equals the empty comparison. Use conspicuous unknown wall time, tokens, rework kinds, and grades. Reinstating only the false fallback must fail this test.
- [A3] Executable: `CLI preserves unresolved rows but excludes them from preparation cohorts` — extend the isolated CLI fixture with a row from the real resolver, serialize and reload it, assert `prepared: null`, then spawn JSON and text reports. Compare both cohort summaries/counts/averages with the known-only baseline; total row count must include the unresolved row. Retain migration stamps and empty coverage roots. Include a legacy missing-field row and an explicit false row to prove persisted compatibility without migration or report-shape changes.

Delivery validation also runs the full scoped test file and `npm run check:standards` through the queue as specified in Proof plan. Contract-comment updates and the review-lens note in Design accompany the tested behavior; these checks are not claimed to have run during preparation.

## Follow-ups

- Historical false rows remain ambiguous. Any historical rescore or migration requires separate work with evidence of the original lookup context; do not infer past readiness from today's cards.
- Hash-ID support, repository-aware lookup, and as-of-dispatch stamp timing remain outside this guard. Their currently unresolvable cases become unknown rather than asserted unprepared.
- The runner owns preparation stamping, checks, and the parked independent review. This preparation neither implements the guard nor claims review approval.
