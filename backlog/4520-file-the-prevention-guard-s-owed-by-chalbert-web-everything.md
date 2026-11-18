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
- Corrected premise/scope: the vocabulary is at `we:scripts/readiness/dispatch-plan.mjs:173`; lifecycle exclusions are at `we:scripts/conveyor/tick-core.mjs:172`; the generic held-note loop is at `we:scripts/conveyor/tick-core.mjs:1743`. Keep the producer and its matching existing test in scope as the dependency under guard; add the consumer and its matching existing test. Expected implementation edits are test-only in the consumer test.
- Previous preparation premise: 15 vocabulary tokens, six lifecycle exclusions, and no vocabulary-wide classification test. That preparation's runtime probe is historical evidence, not a probe of this checkout.
- Current correction: `we:scripts/readiness/dispatch-plan.mjs:173` now declares 16 tokens; `we:scripts/conveyor/tick-core.mjs:172` excludes seven, adding `prepare-stale`. `we:scripts/conveyor/__tests__/tick-core.test.mjs:2490` already rejects tokens absent from both the live exclusions and its explicit generic list. Strengthen that existing guard rather than claim it is absent: it accepts new exclusions automatically and does not prove per-token telemetry or reject stale generic entries. The goal remains partially undelivered.
- Source evidence: selected telemetry cases remain at `we:scripts/conveyor/__tests__/tick-core.test.mjs:1395`, the exact seven exclusions are pinned at `we:scripts/conveyor/__tests__/tick-core.test.mjs:1475`, and dedicated stale-preparation coverage begins at `we:scripts/conveyor/__tests__/tick-core.test.mjs:2479`. The generic emission is at `we:scripts/conveyor/tick-core.mjs:1743`; its shell caller is at `we:scripts/conveyor/tick-core.mjs:2323`. No caller, default, persisted-state format, or runtime suppression policy needs changing.
- Scope remains the producer/consumer and their existing matching tests; permanent implementation edits are confined to `we:scripts/conveyor/__tests__/tick-core.test.mjs`. Size remains 3: approximately 60–90 changed test lines for an explicit table, exact-set assertions, and 16 parameterized telemetry cases, replacing the existing partial guard, plus four independent mutation proofs. No new dependency edge is needed.

## Design

Replace the partial classification guard at `we:scripts/conveyor/__tests__/tick-core.test.mjs:2490` with a test-local, explicit expected classification table in `we:scripts/conveyor/__tests__/tick-core.test.mjs`. Its seven lifecycle entries are `needs-slice`, `needs-decision`, `needs-investigation`, `needs-prepare`, `prepare-stale`, `unshaped-no-scope`, and `no-size`. Its nine generic-note entries are `already-done`, `blocked`, `branch-drift-blocked`, `no free lane`, `capacity-cap`, `overlaps lane-<n>`, `cleared-but-not-ready`, `dispatch-paused`, and `pr-limit`.

Assert exact set equality between the table keys and imported `HELD_REASONS`, plus equality between its lifecycle entries and imported `HELD_NOTE_EXCLUDED_REASONS`. Do not derive the expected table by subtracting exclusions from the vocabulary: that would silently accept every new token. No token is silently transient today; waiting reasons retain their existing notes.

For every vocabulary token, invoke `planTick({ state, plan, bookkeeping })` with empty queue/lanes/PRs, an empty launch list, one held entry with a fixed item number, and tick zero. Materialize `overlaps lane-<n>` as `overlaps lane-17`. Inspect `result.decisions.notes`: generic entries must produce exactly one matching `kind: 'held'` note preserving number, reason, and text; lifecycle entries must produce zero generic notes for that item. Existing lifecycle tests continue to cover dedicated actions/notes. No runtime API, dispatch policy, persistent state, or caller migration changes.

## MVP

1. **Must 1:** Add the explicit exhaustive classification table and vocabulary/exclusion equality assertions in `we:scripts/conveyor/__tests__/tick-core.test.mjs`.
2. **Must 2:** Exercise every token through the real `planTick` and assert the generic-note behavior described above, including concrete overlap rendering.
3. **Must 3:** Demonstrate that the guard detects both an unclassified vocabulary addition and a lost generic held note; retain existing lifecycle coverage.

Deliver as one test-only change. Size 3 remains appropriate for the bounded cross-module regression and mutation evidence. Production classification refactoring and new suppression rules are outside this MVP.

## Test plan

Run all commands through the host heavy-run queue, with one bounded wait and no polling. Run the affected Vitest suites for `we:scripts/conveyor/__tests__/tick-core.test.mjs` and `we:scripts/readiness/__tests__/dispatch-plan.test.mjs`. Name the new test group `held-reason vocabulary coverage` so it can be selected independently. Include equality diagnostics that identify missing/extra tokens rather than only comparing counts. Each source in scope has its existing matching test listed in scope.

## Proof plan

During implementation, record the focused group's passing result, then perform four temporary mutations independently: append an unclassified token to `HELD_REASONS` in `we:scripts/readiness/dispatch-plan.mjs`, add a new token to both the vocabulary and exclusions without changing the expected table, and skip `pr-limit` in the generic-note loop in `we:scripts/conveyor/tick-core.mjs`. Finally bypass the exclusion check in that loop. The first two must fail classification equality (including the formerly auto-accepted exclusion path); the third must fail note visibility and the fourth must fail lifecycle exclusion assertions. Restore each mutation immediately and rerun green. These mutations provide the red/green proof for a missing test guard whose existing runtime behavior is expected to remain unchanged. Run `npm run check:standards` through the same heavy-run queue after the restored suites pass. Record commands, failures, and restored results in the delivery evidence; no live dispatch or agent spawn is required.

## Acceptance

These are regression-guard guarantees. Existing runtime behavior is expected to pass unchanged; red-before/green-after is demonstrated by mutation detection followed by restoration; A1 and A2 additionally expose gaps in the old guard, while A3 retains existing exclusion coverage. Require the new focused group to collect tests (no empty-selection success).

- [A1] Executable: proposed test `held-reason vocabulary coverage > classifies exactly the producer vocabulary and lifecycle exclusions` in `we:scripts/conveyor/__tests__/tick-core.test.mjs`. Exact sorted-set equality rejects missing, extra, and unclassified entries. Add a sentinel to both production vocabulary and exclusions: the current partial guard accepts it; the new equality test must fail. Restore and require green. Also append a sentinel only to the vocabulary to retain the existing closed path.
- [A2] Executable: proposed parameterized test `held-reason vocabulary coverage > preserves generic telemetry for %s` in `we:scripts/conveyor/__tests__/tick-core.test.mjs`. Each of nine generic tokens produces exactly one note with the original item number, concrete reason, and exact text. Temporarily suppress `pr-limit`: existing selected telemetry cases miss it; the new case must fail. Restore and require green; materialize overlap as lane 17.
- [A3] Executable: proposed parameterized test `held-reason vocabulary coverage > excludes lifecycle telemetry for %s` in `we:scripts/conveyor/__tests__/tick-core.test.mjs`. All seven lifecycle tokens, including `prepare-stale`, produce zero generic notes. Temporarily bypass the exclusion check inside the generic-note loop: the new cases must fail; restore and require green. Together A2/A3 traverse all 16 producer tokens with default configuration and no live IO. Existing lifecycle tests remain intact.

Focused command, run from the WE root; shell expansion removes only the documentation repository prefix so every authored path retains its locus:

```sh
runner='we:scripts/readiness/heavy-admission.mjs'
testfile='we:scripts/conveyor/__tests__/tick-core.test.mjs'
node "${runner#we:}" run --wait-ms=60000 -- npx vitest run "${testfile#we:}" -t 'held-reason vocabulary coverage'
```

After mutation restoration, run both affected suites through the same queue:

```sh
runner='we:scripts/readiness/heavy-admission.mjs'
consumer='we:scripts/conveyor/__tests__/tick-core.test.mjs'
producer='we:scripts/readiness/__tests__/dispatch-plan.test.mjs'
node "${runner#we:}" run --wait-ms=60000 -- npx vitest run "${consumer#we:}" "${producer#we:}"
node "${runner#we:}" run --wait-ms=60000 -- npm run check:standards
```

Review the final diff to confirm mutations are restored and only the consumer test changed. Defaults and callers remain unchanged; the fail-closed behavior is a test failure requiring explicit classification, not a new runtime dispatch refusal. The runner owns preparation checks and stamping; the commands above are the build's proof obligations.

## Follow-ups

No additional work is required for this guard. Future vocabulary additions must deliberately update the expected classification and behavior assertions. A future request to suppress transient holds would require its own explicit policy decision; this item does not introduce that behavior. The runner owns preparation stamping/checks and the parked independent review; this preparation does not claim independent acceptance.
