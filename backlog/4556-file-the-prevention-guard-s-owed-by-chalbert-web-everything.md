---
bornAs: x8gnz15
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/readiness/dispatch-plan.mjs", "we:scripts/readiness/__tests__/dispatch-plan*.test.mjs"]
dateOpened: "2026-09-29"
preparedDate: "2026-11-18"
preparedAgainstSha: "3e0a703b8fe4372a1aba3aa0d5c791cb41f81671"
tags: []
---

# File the prevention guard(s) owed by chalbert/web-everything#3011's independent review

Close the independent review's prevention debt: prove that a real backlog-loaded, unprepared candidate reaches preparation planning, and prevent card-declared launch kinds from bypassing build readiness gates. The approval did not waive these guards.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3011@a6530b7cc3def9271ea09c3710b48e5a65f5f635

## Progress

- Original premise/scope: the prior preparation proposed extracting the production mapper and adding a real backlog-to-preparation regression, alongside rejection of scheduler launch kinds in the build queue. The scoped source was we:scripts/readiness/dispatch-plan.mjs with we:scripts/readiness/__tests__/dispatch-plan*.test.mjs.
- Corrected premise: the mapper is already exported as `projectBuildQueueRow` at we:scripts/readiness/dispatch-plan.mjs:833 and used by the shell at we:scripts/readiness/dispatch-plan.mjs:1016. Reuse it; no extraction is owed. The loader call is now we:scripts/readiness/dispatch-plan.mjs:976. Existing mapper coverage is at we:scripts/readiness/__tests__/dispatch-plan.test.mjs:1457.
- The bypass remains visible in source: size exemptions at we:scripts/readiness/dispatch-plan.mjs:578, missing-stamp exemptions at we:scripts/readiness/dispatch-plan.mjs:604, and the newer stale-stamp exemptions at we:scripts/readiness/dispatch-plan.mjs:612. The existing test at we:scripts/readiness/__tests__/dispatch-plan.test.mjs:760 explicitly expects `prepare-item` to bypass preparation. This preparation inspected source; the earlier card's runtime probe was not repeated and is not fresh execution evidence.
- Current route: `cliPlanTick` at we:skills-src/conveyor/build-dispatch-daemon.mjs:1644 invokes the tick shell, whose planner path is we:scripts/conveyor/tick-core.mjs:2054. Preparation candidates are selected at we:scripts/conveyor/tick-core.mjs:1355 and returned at we:scripts/conveyor/tick-core.mjs:1838. They are not build-queue item kinds.
- The six-value canonical `BACKLOG_KINDS` is now at we:scripts/check-standards-rules.mjs:365; static validation at we:scripts/check-standards-rules.mjs:516 does not validate runtime planner inputs. Real-loader fixture support is at we:src/_data/backlog.js:57 and we:src/_data/backlog.js:1048.
- Existing shell-default coverage already loads an unstamped card at we:scripts/conveyor/__tests__/dispatcher-fixture-harness.test.mjs:184; it does not close the loader → mapper → planner → preparation-spawn seam. Preserve that coverage rather than claiming no shell test exists.
- Corrected scope remains the same source and matching test glob: remove the obsolete mapper extraction, include stale-stamp exemption removal, and add the missing seam regression. Size remains 3: approximately 40–60 changed source/comment lines, 90–130 changed unit-test lines, and 100–150 lines in the new loader integration test (roughly 230–340 total). This is a story; no `estimatedLoc` is added. No blocker changes are proposed.

## Design

Keep backlog item kind separate from scheduler launch kind. In we:scripts/readiness/dispatch-plan.mjs, validate the complete queue's explicit kinds against `BACKLOG_KINDS` from we:scripts/check-standards-rules.mjs before allocating lanes or returning a plan. An invalid kind raises a diagnostic TypeError identifying the item and value; a mixed valid/invalid queue returns no partial plan. Undefined kind remains the legacy missing-value case, including the mapper's missing-loader result. Explicit null, blank, non-string and unknown values are invalid. Validation applies even when readiness policies are omitted or disabled.

Remove card-kind exemptions from size, missing-stamp and stale-stamp checks in we:scripts/readiness/dispatch-plan.mjs and update their contract comments. Reuse `projectBuildQueueRow` unchanged unless the regression exposes a projection defect; retain its explicit field projection, prefix normalization, and missing-item behavior. Never copy frontmatter `launchKind` into admission decisions. Genuine preparation/fix/heal scheduling continues through we:scripts/conveyor/tick-core.mjs.

Preserve the core's null policy defaults and the shell's existing enabled preparation default. Valid kinds keep their existing readiness precedence, task estimates, story sizing, grouping/decision/investigation routing, and stamp-format/age semantics. An invalid card is corrected by its author and planning rerun; there is no permissive retry or exemption flag. Missing loader metadata still yields no scope and therefore a hold, not a launch.

## MVP

1. Add whole-queue kind validation and remove all three readiness exemptions in we:scripts/readiness/dispatch-plan.mjs.
2. Replace invalid-kind expectations in we:scripts/readiness/__tests__/dispatch-plan.test.mjs, including `build`, `prepare`, `prepare-decision`, `prepare-item`, `fix` and `ci-heal`. Keep pause-kind tests: scheduler pause vocabulary is a separate input and still accepts launch kinds.
3. Add we:scripts/readiness/__tests__/dispatch-plan-backlog-load.test.mjs using the real loader, existing production mapper, `dispatchPlan`, and `planTick`. Exercise unstamped and stamped stories plus malformed-kind cards through that seam.
4. Do not change loader, tick scheduling, enum, settings defaults or launch routing. Existing callers in we:scripts/operations/__tests__/dispatch-eligibility.test.mjs, we:scripts/operations/__tests__/land-advance.test.mjs and we:scripts/conveyor/soak/breaks/unprepared-card-dispatched-as-build.mjs retain valid or absent backlog kinds; check their compatibility when implementing.

## Test plan

Use temporary Markdown cards under the task's `TMPDIR`, isolate `WE_BACKLOG_DIR` and the CommonJS loader cache, restore both after each test, and clean fixtures. Supply fixed time, empty leases/PRs/bookkeeping, available lanes, and explicit policies. No network, claims, live queue writes or workers.

In we:scripts/readiness/__tests__/dispatch-plan.test.mjs, parameterize all six valid enum kinds, absent/undefined kind, explicit null/blank/non-string/unknown kind, and all obsolete launch-kind fixtures. Assert validation also rejects a bad second row after a valid first row, with policies disabled and with empty lanes or paused dispatch. Check invalid-kind rejection separately from unchanged precedence for valid kinds. Cover fresh, missing and stale stamps, positive task estimates, missing size, and default null policies.

In we:scripts/readiness/__tests__/dispatch-plan-backlog-load.test.mjs, combine the positive seam and negative boundary cases in the named acceptance tests below. A scoped sized unstamped story must hold `needs-prepare` and reach exactly one `spawnPrepareItems`, never `spawnBuilds`; its freshly stamped sibling builds and does not prepare. Malformed launch-kind cards must throw with and without size, and with missing/stale stamps. A story with `launchKind: prepare-item` must remain unprepared, and the projection must exclude that field. Missing loaded metadata must hold `unshaped-no-scope`. Preserve preparation pause/capacity coverage in we:scripts/conveyor/__tests__/tick-core.test.mjs.

## Acceptance

- [A1] Executable: add `rejects non-backlog kinds before any admission, including disabled policies` in we:scripts/readiness/__tests__/dispatch-plan.test.mjs. It covers malformed values, all former launch-kind fixtures, mixed queues, diagnostic item/value, and no returned partial plan. It fails before implementation because the current core accepts these kinds, and passes after validation is unconditional.
- [A2] Executable: add `preserves readiness defaults and precedence while rejecting launch-kind exemptions` in we:scripts/readiness/__tests__/dispatch-plan.test.mjs. In one parameterized suite, assert valid/absent-kind defaults and existing hold precedence, then invalid-kind rejection across size, missing-stamp and stale-stamp policies. The rejection cases fail before implementation; unchanged valid-kind cases are compatibility guards, not claims of a prior defect.
- [A3] Executable: add `routes real loaded stories to preparation and refuses card-declared launch kinds` in we:scripts/readiness/__tests__/dispatch-plan-backlog-load.test.mjs. Run real loader → production mapper → build planner → tick planner for the story pair, then require rejection of loaded launch-kind variants. The combined test fails before implementation on rejection and passes afterward; preparation reachability alone may already pass.
- [A4] Executable: add `projects only trusted build fields and fails closed on malformed kind or missing metadata` in we:scripts/readiness/__tests__/dispatch-plan-backlog-load.test.mjs. Assert frontmatter `launchKind` cannot waive readiness, absent metadata cannot launch, and an explicitly malformed kind throws even when other readiness checks are disabled. The malformed-kind assertion fails before implementation; the projection and missing-metadata assertions protect existing behavior.

## Proof plan

Run the new named acceptance tests against baseline production code first, then after implementation; record command, exit status and failing/passing assertion names. Keep positive seam assertions in the same tests as the red boundary assertions so the acceptance command genuinely goes red before the build without pretending preparation was broken. Reverting only runtime validation must make rejection tests fail again.

All commands use the host queue. Execute `node we:scripts/readiness/heavy-admission.mjs run --wait-ms=60000 -- npx vitest run we:scripts/readiness/__tests__/dispatch-plan.test.mjs we:scripts/readiness/__tests__/dispatch-plan-backlog-load.test.mjs we:scripts/conveyor/__tests__/tick-core.test.mjs` (remove each `we:` prefix when executing locally). Also run the existing caller compatibility tests in we:scripts/operations/__tests__/dispatch-eligibility.test.mjs and we:scripts/operations/__tests__/land-advance.test.mjs through the same queue. Verify the existing CLI-default test in we:scripts/conveyor/__tests__/dispatcher-fixture-harness.test.mjs with its focused test-name filter through that queue.

Run `node we:scripts/readiness/heavy-admission.mjs run --wait-ms=60000 -- npm run check:standards` (remove the `we:` prefix locally). Wait once using the admission tool's own budget if busy, then stop and report; no polling loop. The runner owns preparation stamping and checks for this card-only pass. No runtime tests are claimed as run during this preparation.

## Follow-ups

None required. Stronger stamp provenance, broader loader validation and scheduler policy changes remain outside this item. If another production caller uses launch kinds as backlog kinds, identify its concrete path and matching test, correct the touch set before building, and preserve fail-closed validation rather than restoring a frontmatter exemption.

## Done when

A1–A4 have recorded red/green evidence, the real loader-to-preparation seam is exercised, caller compatibility and focused scheduler tests pass, and the standards gate passes. No new policy or blocker decision is required.
