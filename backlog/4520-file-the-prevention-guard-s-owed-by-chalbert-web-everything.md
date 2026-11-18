---
bornAs: xt3rawp
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/readiness/dispatch-plan.mjs", "we:scripts/readiness/__tests__/dispatch-plan.test.mjs", "we:scripts/conveyor/tick-core.mjs", "we:scripts/conveyor/__tests__/tick-core.test.mjs"]
dateOpened: "2026-09-29"
preparedDate: "2026-11-18"
preparedAgainstSha: "2d59586e46f3fdfbd3cf6853afe6d6b1316b71c8"
tags: []
---

# File the prevention guard(s) owed by chalbert/web-everything#2960's independent review

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. Add an exhaustive held-reason classification and telemetry regression test in `we:scripts/conveyor/__tests__/tick-core.test.mjs`, consuming `HELD_REASONS` from `we:scripts/readiness/dispatch-plan.mjs:173` and exercising `planTick` from `we:scripts/conveyor/tick-core.mjs:1232`. Every token must be explicitly accounted for, and every non-excluded reason must remain visible. This preserves the prevention goal of refusing an unclassified vocabulary addition without introducing a new suppression policy.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#2960@cc6d46fe91c1e4d57e868878289ccd3753767ec9

## Progress

- Original premise/scope: the review cited `we:scripts/readiness/dispatch-plan.mjs:564`, scoped only that producer and `we:scripts/readiness/__tests__/dispatch-plan.test.mjs`, and described an excluded-or-transient partition. That citation now falls inside dispatch planning, not tick telemetry.
- Corrected premise/scope: the vocabulary is at `we:scripts/readiness/dispatch-plan.mjs:173`; lifecycle exclusions are at `we:scripts/conveyor/tick-core.mjs:172`; the generic held-note loop is at `we:scripts/conveyor/tick-core.mjs:1742`. Keep the producer and its matching existing test in scope as the dependency under guard; add the consumer and its matching existing test. Expected implementation edits are test-only in the consumer test.
- Re-preparation correction: the prior card assumed 15 tokens, six exclusions, and no exhaustive classification test. Current scope remains the four listed producer/consumer and matching test paths; only the consumer test needs permanent edits. The current vocabulary has 16 tokens and seven exclusions, including `prepare-stale` (`we:scripts/readiness/dispatch-plan.mjs:173`, `we:scripts/conveyor/tick-core.mjs:172`).
- Source evidence: `we:scripts/conveyor/__tests__/tick-core.test.mjs:2490` already checks for unclassified reasons using a literal generic list plus the runtime exclusion list. It does not reject obsolete expected entries or exercise every token through telemetry; automatically accepting a new runtime exclusion also bypasses an explicit test-local classification choice. Selected telemetry tests remain at `we:scripts/conveyor/__tests__/tick-core.test.mjs:1394`, the explicit exclusion assertion is at line 1475 of that same file, and `prepare-stale` has dedicated coverage at `we:scripts/conveyor/__tests__/tick-core.test.mjs:2480`. Producer coverage exists at `we:scripts/readiness/__tests__/dispatch-plan.test.mjs:1401`.
- The earlier preparation's 15-token runtime probe is historical evidence, not a probe of this checkout. Current source inspection shows the generic loop emits each non-excluded reason unchanged (`we:scripts/conveyor/tick-core.mjs:1742`); the build must prove the complete 16-token behavior through the tests below. The goal is partially delivered, not already done.
- Size remains 3: approximately 60–90 changed lines in `we:scripts/conveyor/__tests__/tick-core.test.mjs:2490` to strengthen/move the existing classification assertion and add parameterized telemetry cases; zero permanent production or producer-test changes. The other scoped files identify the guarded dependency and its existing test, and the temporary mutation targets.

## Design

Strengthen the existing classification test with a test-local, explicit expected classification table in `we:scripts/conveyor/__tests__/tick-core.test.mjs`. Its seven lifecycle entries are `needs-slice`, `needs-decision`, `needs-investigation`, `needs-prepare`, `prepare-stale`, `unshaped-no-scope`, and `no-size`. Its nine generic-note entries are `already-done`, `blocked`, `branch-drift-blocked`, `no free lane`, `capacity-cap`, `overlaps lane-<n>`, `cleared-but-not-ready`, `dispatch-paused`, and `pr-limit`.

Assert exact set equality between the table keys and imported `HELD_REASONS`, plus equality between its lifecycle entries and imported `HELD_NOTE_EXCLUDED_REASONS`. Do not derive the expected table by subtracting exclusions from the vocabulary: that would silently accept every new token. No token is silently transient today; waiting reasons retain their existing notes.

For every vocabulary token, invoke `planTick({ state, plan, bookkeeping })` with empty queue/lanes/PRs, an empty launch list, one held entry with a fixed item number, and tick zero. Materialize `overlaps lane-<n>` as `overlaps lane-17`. Inspect `result.decisions.notes`: generic entries must produce exactly one matching `kind: 'held'` note preserving number, reason, and text; lifecycle entries must produce zero generic notes for that item. Existing lifecycle tests continue to cover dedicated actions/notes. No runtime API, dispatch policy, persistent state, or caller migration changes.

## MVP

1. **Must 1:** Add the explicit exhaustive classification table and vocabulary/exclusion equality assertions in `we:scripts/conveyor/__tests__/tick-core.test.mjs`.
2. **Must 2:** Exercise every token through the real `planTick` and assert the generic-note behavior described above, including concrete overlap rendering.
3. **Must 3:** Demonstrate that the guard detects both an unclassified vocabulary addition and a lost generic held note; retain existing lifecycle coverage.

Deliver as one test-only change. Size 3 remains appropriate for the bounded cross-module regression and mutation evidence. Production classification refactoring and new suppression rules are outside this MVP.

## Test plan

Run the affected Vitest suites for `we:scripts/conveyor/__tests__/tick-core.test.mjs` and `we:scripts/readiness/__tests__/dispatch-plan.test.mjs`. Name the new test group `held-reason vocabulary coverage` so it can be selected independently. Include equality diagnostics that identify missing/extra tokens rather than only comparing counts. Each source in scope has its existing matching test listed in scope.

## Proof plan

During implementation, record the focused group's passing result, then perform two temporary mutations independently: append an unclassified token to `HELD_REASONS` in `we:scripts/readiness/dispatch-plan.mjs`, and skip `pr-limit` in the generic-note loop in `we:scripts/conveyor/tick-core.mjs`. The first must fail classification equality; the second must fail note visibility. Restore each mutation immediately and rerun green. These mutations provide the red/green proof for a missing test guard whose existing runtime behavior already works. Run the queued standards command in Acceptance after the restored suites pass. Also perform the obsolete-entry, newly-excluded-token, and removed-exclusion mutations specified there, independently and with immediate restoration. Record commands, failures, and restored results in the delivery evidence; no live dispatch or agent spawn is required.

## Acceptance

Use the named tests below in the new `held-reason vocabulary coverage` group in `we:scripts/conveyor/__tests__/tick-core.test.mjs`. Executable command notation uses repository-qualified paths; remove each `we:` prefix when executing from the WE root. All executions go through `we:scripts/readiness/heavy-admission.mjs`.

- [A1] Executable: `node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:scripts/conveyor/__tests__/tick-core.test.mjs -t 'held-reason vocabulary coverage'` — test `classifies exactly the producer vocabulary and lifecycle exclusions` asserts exact sorted equality for both sets. Before the build this exact guard is absent. Demonstrate red with an unclassified producer token, an obsolete table entry, and a new producer token also added to runtime exclusions; after the build all must fail until explicitly classified or restored. This is the fail-closed path: report missing/extra tokens and require a deliberate table update, never silently infer a category.
- [A2] Executable: the same focused command — parameterized test `preserves generic held telemetry for %s` covers all nine generic tokens, asserting exactly one held note with the item number, concrete reason and exact text. Replace the overlap placeholder with lane 17. Suppressing `pr-limit` must fail after the guard is built; the existing classification-only test misses that mutation. Restore the loop and require green.
- [A3] Executable: the same focused command — parameterized test `avoids duplicate generic telemetry for %s` covers all seven lifecycle tokens, including `prepare-stale`. Removing an exclusion must make this guard red; restore it and require green. Before this build the per-token telemetry guard is absent. Preserve existing dedicated lifecycle tests.

No defaults, runtime callers, persisted state, or policy change. As supporting regression validation, run `node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:scripts/conveyor/__tests__/tick-core.test.mjs we:scripts/readiness/__tests__/dispatch-plan.test.mjs` and `node we:scripts/readiness/heavy-admission.mjs run -- npm run check:standards`. These existing checks are supporting green checks, not claimed pre-build failures. Inspect the final diff to confirm every temporary mutation is restored.

## Follow-ups

No additional work is required for this guard. Future vocabulary additions must deliberately update the expected classification and behavior assertions. A future request to suppress transient holds would require its own explicit policy decision; this item does not introduce that behavior. The runner owns preparation stamping/checks and the parked independent review; this preparation does not claim independent acceptance.
