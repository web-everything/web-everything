---
bornAs: x8gnz15
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/readiness/dispatch-plan.mjs", "we:scripts/readiness/__tests__/dispatch-plan*.test.mjs"]
dateOpened: "2026-09-29"
preparedDate: "2026-11-18"
preparedAgainstSha: "f018d85dbc154dd5b7d33c86ebccc4d79be0e698"
tags: []
---

# File the prevention guard(s) owed by chalbert/web-everything#3011's independent review

Close the independent review's prevention debt: prove that a real backlog-loaded, unprepared candidate reaches preparation planning, and prevent card-declared launch kinds from bypassing build readiness gates. The approval did not waive these guards.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3011@a6530b7cc3def9271ea09c3710b48e5a65f5f635

## Progress

- Previous preparation assumed the production mapping still needed extraction, cited the loader at we:scripts/readiness/dispatch-plan.mjs:848, and covered size and missing-stamp exemptions only. Original review citations were we:scripts/readiness/dispatch-plan.mjs:582 and we:scripts/readiness/dispatch-plan.mjs:584; those are historical, not current evidence.
- Current source evidence: `projectBuildQueueRow` already exists at we:scripts/readiness/dispatch-plan.mjs:833 and is used at we:scripts/readiness/dispatch-plan.mjs:1016; the real loader is invoked at we:scripts/readiness/dispatch-plan.mjs:976. Reuse that helper instead of extracting another. Existing projection coverage lives at we:scripts/readiness/__tests__/dispatch-plan.test.mjs:1455.
- The bypass remains in source: size exemption at we:scripts/readiness/dispatch-plan.mjs:578, missing-stamp exemption at we:scripts/readiness/dispatch-plan.mjs:604, and newer staleness exemption at we:scripts/readiness/dispatch-plan.mjs:612. The launch result also uses `sizeExempt` at we:scripts/readiness/dispatch-plan.mjs:681. Remove all four uses consistently. This is source inspection, not a new live-daemon or runtime-test claim.
- Current route: `cliPlanTick` at we:skills-src/conveyor/build-dispatch-daemon.mjs:1644 invokes the shell in we:scripts/conveyor/tick-core.mjs:2047, whose planner path is set at we:scripts/conveyor/tick-core.mjs:2054. Preparation consumes real readiness holds at we:scripts/conveyor/tick-core.mjs:1355 and returns `spawnPrepareItems` at we:scripts/conveyor/tick-core.mjs:1838. Card kinds need no launch-kind exemption.
- The six canonical values remain in `BACKLOG_KINDS` at we:scripts/check-standards-rules.mjs:365; static validation at we:scripts/check-standards-rules.mjs:516 does not replace runtime admission validation. Existing tests explicitly expect exemptions at we:scripts/readiness/__tests__/dispatch-plan.test.mjs:712, we:scripts/readiness/__tests__/dispatch-plan.test.mjs:723, we:scripts/readiness/__tests__/dispatch-plan.test.mjs:760, we:scripts/readiness/__tests__/dispatch-plan.test.mjs:822 and we:scripts/readiness/__tests__/dispatch-plan.test.mjs:832; update these callers deliberately.
- Corrected scope retains the production planner and matching test wildcard, including the planned we:scripts/readiness/__tests__/dispatch-plan-backlog-load.test.mjs. Loader and tick core remain exercised dependencies. Keep size 3: approximately 35–55 changed planner lines, 90–130 unit-test lines and 100–140 new integration-test lines across three files. No `estimatedLoc` is added to this story. The goal is not already delivered; the correction reuses existing mapping and includes the current staleness gate without changing scheduling policy. Existing preparation stamps are left for the runner to replace.

## Design

Keep backlog item kind separate from scheduler launch kind. `dispatchPlan` schedules builds; validate every queue `kind` other than `undefined` (the existing absent-kind representation) against the canonical `BACKLOG_KINDS` before admission. Reject invalid values with a diagnostic TypeError identifying the item and invalid kind, without returning any launch plan. Validate the entire queue before assigning lanes, even when the invalid row is blocked, paused or behind a valid row. Null, blank, non-string and unknown values are invalid; only absent/undefined retains compatibility. The diagnostic directs the operator to correct the card kind and rerun planning; do not silently skip the card or retry with relaxed gates. Preserve the existing missing-kind fallback for loader failure and legacy direct callers; absence must confer no exemption.

Remove the `prepare-item`, `fix`, and `ci-heal` exemptions based on `item.kind` from we:scripts/readiness/dispatch-plan.mjs, including the staleness gate, launch-result `sized` projection and misleading contract comments. Do not add a card-controllable `launchKind` exemption: genuine preparation/fix/heal scheduling already occurs separately in we:scripts/conveyor/tick-core.mjs. Keep existing hold precedence, sizing rules for tasks/stories, lane admission, and stamp-format semantics for valid backlog kinds.

Reuse `projectBuildQueueRow` in we:scripts/readiness/dispatch-plan.mjs:833, already wired into the production shell. Preserve its explicit field projection, scope normalization and missing-item behavior; never spread arbitrary frontmatter into planner inputs. Use the actual production mapper in regressions. Keep null policy defaults unchanged: size and preparation checks remain opt-in for direct callers, but explicit invalid kinds are rejected regardless of policy. A missing loaded item retains undefined kind and scope and holds `unshaped-no-scope`. Keep date-format and staleness semantics for valid cards unchanged.

## MVP

1. Add runtime item-kind validation using the existing enum and remove launch-kind exemptions in we:scripts/readiness/dispatch-plan.mjs.
2. Reuse the already-exported production queue mapping in that same source. Do not change the backlog loader, tick scheduler, launch routing, or enum.
3. Update we:scripts/readiness/__tests__/dispatch-plan.test.mjs to replace launch-kind-as-item-kind expectations with rejection assertions and preserve valid-kind readiness/precedence coverage.
4. Add we:scripts/readiness/__tests__/dispatch-plan-backlog-load.test.mjs, loading temporary Markdown cards with the real backlog loader, using the production mapping and `dispatchPlan`, then feeding its real result to `planTick`. Assert an unprepared story is absent from build launches and present in `spawnPrepareItems` when capacity is available.

## Test plan

- In we:scripts/readiness/__tests__/dispatch-plan-backlog-load.test.mjs, create fixtures beneath the task’s `$TMPDIR`, isolate `WE_BACKLOG_DIR` and the CommonJS loader cache, restore them after each test, and clean temporary files. Use fixed clock, empty leases/PRs/bookkeeping, available lanes, and explicit size/prepare policies. No network, workers, claims, or live queue writes.
- Load a scoped size-3 story with no stamp: verify the mapped `kind` remains `story`, the build plan holds `needs-prepare`, and `planTick` emits exactly that candidate in `spawnPrepareItems`, never `spawnBuilds`. A stamped sibling is eligible for build and not preparation.
- Load cards declaring each of `prepare-item`, `fix`, and `ci-heal`; run the same production mapping and assert runtime rejection. Repeat with no size and with a valid size to show neither gate can be bypassed. A valid story carrying frontmatter `launchKind: prepare-item` must still hold `needs-prepare`; the mapper must not copy that field.
- In we:scripts/readiness/__tests__/dispatch-plan.test.mjs, cover all six valid enum values, unknown/null/blank/non-string explicit kinds, absent/undefined kind, mixed valid/invalid queues, policy-off rejection, stale-stamp rejection pairs, missing-loader rows, and unchanged blocked/grouping/decision/investigation/scope/size/prepare precedence. Keep genuine preparation's pause/capacity behavior covered by the existing we:scripts/conveyor/__tests__/tick-core.test.mjs suite.

## Proof plan

Run the new focused regressions against the baseline first: rejection assertions must fail on today's exempt launch-kind rows. The positive backlog-to-preparation test may already pass; retain it as the missing seam guard, not as evidence of a previously broken preparation route. After implementation, run both focused test files and the existing tick-core suite; record commands, exit status and assertion results. Reverting only runtime validation/exemption removal must make the bypass regressions fail again.

Run tests only through the host queue: `node we:scripts/readiness/heavy-admission.mjs run --wait-ms=60000 -- npx vitest run we:scripts/readiness/__tests__/dispatch-plan.test.mjs we:scripts/readiness/__tests__/dispatch-plan-backlog-load.test.mjs we:scripts/conveyor/__tests__/tick-core.test.mjs`. Repository prefixes identify paths in this card; strip `we:` only when executing from the WE checkout. Run the standards gate through `node we:scripts/readiness/heavy-admission.mjs run --wait-ms=60000 -- npm run check:standards`. If admission remains busy after that single bounded wait, stop and report. The temporary-card test must execute the real loader and production mapper; a source-text grep or prebuilt `needs-prepare` plan is insufficient proof.

## Acceptance

Each named test below is planned in the scoped test files. Each combines the preserved positive behavior with a rejection assertion that fails on the baseline, so unchanged behavior alone cannot satisfy acceptance. Run them through the focused queue command in Proof plan; record baseline failure and post-build success for each name.

- [A1] Executable: `backlog preparation remains reachable and launch-kind cards are rejected` in we:scripts/readiness/__tests__/dispatch-plan-backlog-load.test.mjs loads real temporary cards through we:src/_data/backlog.js, maps them with `projectBuildQueueRow`, and passes the actual build plan to `planTick`. Assert an unprepared size-3 story reaches only preparation, a stamped sibling reaches build, and cards declaring each launch kind throw. The final assertion fails before implementation.
- [A2] Executable: `invalid kinds reject the whole queue under every policy` in we:scripts/readiness/__tests__/dispatch-plan.test.mjs checks all three launch kinds and unknown/null/blank/non-string kinds, with size missing/present, policies enabled/omitted, a valid preceding row, blocked rows and pause. Assert a diagnostic TypeError naming item/kind and correction action, with no returned partial plan. These rejection assertions fail on the baseline.
- [A3] Executable: `readiness compatibility cannot confer launch exemptions` in we:scripts/readiness/__tests__/dispatch-plan.test.mjs pairs rejection of launch kinds with all six valid kinds, absent/undefined kind, policy-off defaults, valid-kind hold precedence and `sized` result shape. Include current and stale stamps under enabled max-age policy. Replace the old exemption fixtures explicitly; genuine launch kinds remain in tick-core scheduling tests. Baseline fails the rejection side of each pair.
- [A4] Executable: `production projection fails closed without accepting frontmatter escape hatches` in we:scripts/readiness/__tests__/dispatch-plan-backlog-load.test.mjs pairs an invalid-kind loaded card rejection with a story carrying `launchKind: prepare-item` (field omitted, held for preparation), normalization assertions and a missing loaded item (held `unshaped-no-scope`). Baseline fails invalid-kind rejection; the other assertions pin the fallback and production caller contract.

## Follow-ups

None required for this prevention guard. Stronger preparation-stamp provenance, broader malformed-card validation and scheduler policy changes remain outside this item. If implementation discovers another production caller using launch kinds as item kinds, identify its concrete call path and matching test and correct scope before proceeding; do not silently restore a frontmatter-based exemption.

## Done when

The backlog-load regression proves preparation remains reachable, runtime queue validation rejects launch-kind card values, frontmatter cannot supply an exemption, and the focused regression command plus standards gate pass. Record red/green evidence for the bypass guard; preparation alone does not satisfy this delivery criterion.
