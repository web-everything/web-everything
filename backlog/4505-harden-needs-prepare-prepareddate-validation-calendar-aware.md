---
bornAs: xvou4u3
kind: task
status: open
scope: ["we:scripts/readiness/dispatch-plan.mjs", "we:scripts/backlog.mjs", "we:scripts/readiness/engine.mjs", "we:scripts/lib/prepared-date.mjs", "we:scripts/readiness/__tests__/dispatch-plan.test.mjs", "we:scripts/__tests__/backlog-prepare-stamp-status.test.mjs", "we:scripts/readiness/__tests__/engine.test.mjs", "we:scripts/lib/__tests__/prepared-date.test.mjs"]
estimatedLoc: 240
dateOpened: "2026-09-29"
preparedDate: "2026-11-16"
preparedAgainstSha: "578083a15a2d401dab86a9a48f5c7fd3522e508c"
tags: []
---

# Harden needs-prepare preparedDate validation: calendar-aware, Date-object-safe, one shared isPreparedDate() helper

Make prepared-date validity consistent across dispatch admission, readiness selection, and stamp production. Impossible calendar dates must not count as preparation. Valid Date objects must be accepted using their UTC ISO calendar date, including when evaluating preparation age. This validates a self-attested date, not the truth of the preparation work.

## Progress

- Original premise: three equivalent shape checks existed in the dispatcher, engine, and stamp writer; Date input was a theoretical future-loader risk. Original scope named only three source files, with no tests or estimate.
- Corrected premise: the literal shape-only gate is at we:scripts/readiness/dispatch-plan.mjs:604. A second shape-only predicate exists in its age consumer at we:scripts/readiness/dispatch-plan.mjs:696. The engine instead uses truthiness for projection and Tier-B ranking at we:scripts/readiness/engine.mjs:146 and we:scripts/readiness/engine.mjs:190; its prepared count uses the projected flag at we:scripts/readiness/engine.mjs:222. The writer generates a local date and quotes it without validation at we:scripts/backlog.mjs:620-624. No shared isPreparedDate implementation was found in the script tree. The original goal is not delivered.
- Corrected scope: retain those three sources; add a pure helper and four matching test files. Include the existing age consumer so a newly accepted Date cannot bypass maxAgeDays. Existing tests live at we:scripts/readiness/__tests__/dispatch-plan.test.mjs:790, we:scripts/readiness/__tests__/dispatch-plan.test.mjs:1403, we:scripts/__tests__/backlog-prepare-stamp-status.test.mjs:32, and we:scripts/readiness/__tests__/engine.test.mjs:16. The engine fixture builder currently drops preparedDate at we:scripts/readiness/__tests__/engine.test.mjs:41-53; carry it through explicitly.
- The production shell loads we:src/_data/backlog.js at we:scripts/readiness/dispatch-plan.mjs:976 and forwards the date at we:scripts/readiness/dispatch-plan.mjs:857. The loader uses gray-matter at we:src/_data/backlog.js:26. A Date-valued loader result has not been probed here; do not claim an observed production incident. The writer's quoted output remains compatible.
- Estimate was absent; set estimatedLoc to 240: helper 35 + dispatcher 25 + engine 10 + writer 5 + helper tests 55 + dispatch tests 50 + engine tests 35 + writer tests 25. These are estimated changed lines, grounded in the touch points above; no size or dependency change is needed.

## Design

Add we:scripts/lib/prepared-date.mjs with a pure boolean isPreparedDate(value) and a normalization function normalizePreparedDate(value) returning a canonical date string or null. Keep the calendar validation in one implementation; the boolean helper delegates to normalization. Accept only exact four-digit-year YYYY-MM-DD strings or valid Date instances whose UTC ISO date fits that same shape. Reject whitespace, timestamps supplied as strings, numbers, booleans, null, undefined, arbitrary objects, invalid Date instances, and expanded ISO years. Validate month/day and Gregorian leap years without relying on Date.parse rollover; preserve years 0000–0099 without the Date.UTC two-digit-year offset. Never mutate input or throw for ordinary unsupported values.

Wire isPreparedDate into admission in we:scripts/readiness/dispatch-plan.mjs, projection and prepared-first ranking in we:scripts/readiness/engine.mjs, and a pre-write guard on localToday's output in we:scripts/backlog.mjs. The writer continues producing a quoted operator-local calendar date; Date normalization is for supplied values and does not replace the writer's clock. A failed writer validation must exit nonzero with an actionable date-validation error before writing any bytes; the operator corrects the clock/date producer and retries.

Use normalization for both date operands in prepareStaleness in we:scripts/readiness/dispatch-plan.mjs, then calculate age from UTC midnights. This keeps Date and string values equivalent and removes the additional inline shape predicate. Preserve maxAgeDays thresholds, drift handling, and the existing unknown-age return-null contract. Invalid preparedDate fails closed at admission before age evaluation when requirePreparedDate is enabled.

Keep the policy default disabled for direct callers, production opt-in and the no-prepare-check override, gate precedence, and prepare-item/fix/ci-heal exemptions. Change the engine's malformed truthy stamps to unprepared consistently in flags, ranking and counts. Preserve raw preparedDate in projected output to avoid an unrelated serialization migration. Correct the misleading format-equivalence comments.

## MVP

Must deliver the shared validator/normalizer, all scoped consumers, calendar/Date edge cases, writer refusal before mutation, and caller regression coverage. No new configuration or persistent-state migration: existing quoted valid stamps retain behavior; malformed persisted stamps now require preparation through the existing needs-prepare recovery path.

Could extend the same rule to unrelated reporting consumers later. Do not expand this build into provenance verification, timezone policy, preparation-content validation, or a global date-field migration.

## Acceptance

Each named regression below is to be added during build and demonstrated red on the parent implementation, then green after implementation. Existing compatibility assertions belong in those same tests so passing does not conceal a changed default.

- [A1] Executable — proposed test “prepared-date calendar and type matrix” in we:scripts/lib/__tests__/prepared-date.test.mjs: reject 2026-13-45, 2026-02-30, 1900-02-29, month/day zero, missing and unsupported inputs, invalid Date and expanded years; accept 2000-02-29, 2024-02-29, ordinary valid dates, and four-digit early years. Valid Date inputs normalize to their ISO UTC day without mutation. The test fails before build because the helper is absent.
- [A2] Executable — proposed test “calendar-invalid stamps hold; Date stamps obey admission policy” in we:scripts/readiness/__tests__/dispatch-plan.test.mjs: invalid persisted strings and invalid Date yield needs-prepare with no launch; valid Date launches. In the same matrix pin omitted-policy behavior, production-shaped opt-in, exemptions and earlier hold precedence. Before build the impossible strings launch and valid Dates hold.
- [A3] Executable — proposed test “Date and string stamps have identical age boundaries” in we:scripts/readiness/__tests__/dispatch-plan.test.mjs: old Date holds prepare-stale with the same canonical detail as its string equivalent; equal-to-max-age and fresh values pass. Pin unknown-age and drift behavior. Before build Date inputs bypass age evaluation in prepareStaleness and fail the admission gate instead.
- [A4] Executable — proposed test “invalid truthy dates are unprepared in flags ranking and counts” in we:scripts/readiness/__tests__/engine.test.mjs: mix invalid strings, invalid Date, valid strings and valid Date with adversarial leverage order; assert valid-first ranking, prepared flags and tierBPrepared count agree. Before build truthiness includes invalid stamps.
- [A5] Executable — proposed test “prepare-stamp refuses invalid generated dates without writes” in we:scripts/__tests__/backlog-prepare-stamp-status.test.mjs: use a hermetic subprocess loader/mock for the local-date dependency to supply 2026-02-30; assert nonzero exit, date-validation diagnostic and byte-identical card. Also assert a valid supplied day is quoted, accepted by the helper, idempotent and preserves existing status/SHA behavior. Before build the invalid date is written.
- [A6] Executable — proposed test “prepared-date consumers use the shared helper” in we:scripts/lib/__tests__/prepared-date.test.mjs: inspect the three source consumers for the shared import and expected call sites, and assert absence of independent prepared-date shape predicates in them. Keep behavioral A1–A5 as the primary evidence. Before build imports/calls are missing and the dispatch predicates remain duplicated.

## Test plan

Implement A1–A6 in the four scoped test files. Use table-driven input cases, fixed dates, and temporary repositories rooted in the test environment's TMPDIR. For writer failure injection, intercept only the local-date module in the child process; do not add a production clock override or import the CLI into Vitest. Preserve existing fixture expectations and add preparedDate to the engine fixture builder.

Run only those four files through the host heavy-run queue. Command notation below uses repository-qualified paths; to execute from the WE root, remove the leading we: from each path argument:

`node we:scripts/readiness/heavy-admission.mjs run --wait-ms=60000 -- npx vitest run we:scripts/lib/__tests__/prepared-date.test.mjs we:scripts/readiness/__tests__/dispatch-plan.test.mjs we:scripts/readiness/__tests__/engine.test.mjs we:scripts/__tests__/backlog-prepare-stamp-status.test.mjs`

If admission remains busy after this single bounded wait, stop and report. No polling or full-suite run.

## Proof plan

During build, capture named A1–A6 red results before implementation and green results afterward, including held reasons, engine rank/count assertions, and the unchanged writer fixture on failure. Inspect the scoped diff and search the three consumers to confirm the shared imports and removal of both dispatch regex predicates; a grep count alone is not behavioral proof. Run the standards gate through `node we:scripts/readiness/heavy-admission.mjs run --wait-ms=60000 -- npm run check:standards` using the same path translation and one-wait rule. The preparation worker changes only this card; runner-owned stamping and checks remain with the runner.

## Follow-ups

- The loader's separate website counts still use truthiness at we:src/_data/backlog.js:846 and we:src/_data/backlog.js:866. Unifying those display counters is a separate follow-up, not a claim made by this dispatch/engine task.
- Stronger evidence that a valid stamp represents real preparation remains outside this calendar-validation change; retain existing provenance and staleness mechanisms.
