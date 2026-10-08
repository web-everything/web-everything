---
bornAs: x1m4guv
kind: story
size: 3
parent: "4075"
status: active
scope: ["we:scripts/readiness/heavy-admission.mjs", "we:scripts/readiness/__tests__/heavy-admission.test.mjs"]
dateOpened: "2026-09-28"
dateStarted: "2026-10-08"
preparedDate: "2026-10-07"
preparedAgainstSha: "8aadcd16e1ff57477289ba42e0d9dbc6fd8ebd1a"
tags: []
---

# File the prevention guard(s) owed by chalbert/web-everything#2845's independent review

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/readiness/heavy-admission.mjs` — Add deterministic regression tests for null idle attributes and null idle-array entries, requiring fallback or omission rather than a fabricated zero.
2. `we:scripts/readiness/__tests__/heavy-admission.test.mjs` — Change the fixture to pressure readings [2,2,1] and assert the latest reading admits; this deterministic regression test distinguishes latest selection from median selection.
3. `we:scripts/readiness/heavy-admission.mjs` — Use strict type-checking or the same `val == null ? NaN : Number(val)` guard.
4. `we:scripts/readiness/heavy-admission.mjs` — Add an explicit branch in the fallback ternary chain for `decision.pressureLevel != null`.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#2845@1bb9c9117ae72ceefa0ac0b45dddc162199c38cd

## Done when

1. Nullish idle attributes fall back to a finite busy reading; nullish idle-array entries are omitted. Missing readings never become fabricated zero idle or 100% idle.
2. A timestamp-ordered pressure fixture [2, 2, 1] returns the latest value 1 and admits under the default pressure threshold.
3. Plain-text load status reports an admitted pressure-only reading instead of “no sample”, while preserving held reasons and idle → pressure → backstop → no-sample fallback precedence.
4. The regression cases in `we:scripts/readiness/__tests__/heavy-admission.test.mjs` fail against the affected old behavior and pass after implementation, through the host heavy-run queue.

## Progress

- Implementation sanity read (2026-10-08): the three unguarded idle conversions and missing pressure display branch remain present; latest-pressure selection is already correct. The spec is coherent and still applicable. Adding missing/zero/string reading cases and CLI precedence regressions before changing production code.
- Regression proof (2026-10-08): targeted tests through the host heavy-run queue failed against the old source in 11 cases (11 passed). Examples: mixed nullish idle entries returned 20 instead of 40; null idle with busy 63 returned 0 instead of 37; absent idle with null busy returned 100 instead of no reading; admitted pressure-only text said `admitted — no sample`, and pressure plus backstop selected backstop. The strengthened [2, 2, 1] fixture passed latest selection. A temporary median-selection mutation failed with `expected 2 to be 1`; production latest selection was restored in a `finally` block.
- Implementation: guarded all three idle conversions, added the pressure display branch after idle, covered reader-to-decision and CLI text/JSON paths, and fixed the existing empty-root fixture cleanup.
- Verification (2026-10-08): `node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:scripts/readiness/__tests__/heavy-admission.test.mjs` passed all 148 tests. Fixture-driven subprocess assertions verified `admitted — mem pressure 1 (threshold 2)`, `HELD — mem pressure 2 (>=2)`, idle-first admitted text, pressure-before-backstop admitted text, and preservation of held backstop reasons. JSON retained pressure 1 with null idle/per-core for pressure-only input. Before/failure, mutation, and after/pass logs are at `/tmp/conveyor-4408-before.log`, `/tmp/conveyor-4408-median.log`, and `/tmp/conveyor-4408-after.log`. The delivery wrapper owns the standards gate and commit under this session's brief; neither was run by this agent.
- Preparation inspection: the original premise listed four review debts against `we:scripts/readiness/heavy-admission.mjs` and `we:scripts/readiness/__tests__/heavy-admission.test.mjs`, but left the numeric guard's exact target and executable acceptance unspecified. The corrected scope remains those same two files: null handling at the idle-array and telemetry conversion seams, a discriminating pressure fixture, and admitted-pressure text reporting. No code relocation or additional source/test file is required.
- Source evidence: `we:scripts/readiness/heavy-admission.mjs:403` still uses `.map(Number)` on idle entries; `we:scripts/readiness/heavy-admission.mjs:474-477` converts both the idle attribute and fallback busy value without a null guard. Conversely, pressure/load/core inputs already have null guards at `we:scripts/readiness/heavy-admission.mjs:408-410`; do not redo those. The fallback busy guard is part of the same missing-reading correction: guarding only the attribute would let a null busy value fabricate 100% idle.
- Latest pressure selection already exists at `we:scripts/readiness/heavy-admission.mjs:485`. The fixture at `we:scripts/readiness/__tests__/heavy-admission.test.mjs:1030-1037` is [1, 2, 1], whose median and latest are both 1; this debt is a regression-strengthening change, not a new selection algorithm.
- Text reporting at `we:scripts/readiness/heavy-admission.mjs:1370-1376` skips pressure between idle and backstop. The existing CLI regression at `we:scripts/readiness/__tests__/heavy-admission.test.mjs:1233-1264` covers idle-held, admitted backstop, and no sample, but not admitted pressure.
- Size remains 3: two local conversion changes, one local display branch, and additions to existing reader/decision/CLI suites at the cited locations. No policy fork or dependency change is required. This is preparation only; implementation and executable verification remain outstanding.

## Design

Keep the existing admission thresholds, idle median, latest pressure selection, and missing-data fail-open behavior. In `we:scripts/readiness/heavy-admission.mjs`, apply the existing `value == null ? NaN : Number(value)` idiom to idle-array entries, idle attributes, and fallback busy values. Continue filtering non-finite results. Preserve numeric zero as a genuine reading and existing numeric-string conversion behavior.

For telemetry, prefer a finite idle attribute; otherwise derive `100 - busy` only from a finite, non-nullish busy value; otherwise omit the sample. Do not change timestamp windowing or shared telemetry extraction.

In the plain-text fallback chain, insert `decision.pressureLevel != null` after idle and before backstop, reporting `mem pressure <level> (threshold <minPressureLevel>)`. Keep explicit held reasons first and JSON output unchanged. Update the adjacent precedence comment. Use the existing temporary telemetry fixtures and CLI subprocess seam in `we:scripts/readiness/__tests__/heavy-admission.test.mjs`; no new public interface is needed.

## MVP

1. Add the missing-reading regressions to `we:scripts/readiness/__tests__/heavy-admission.test.mjs`, then guard the three idle-related conversions in `we:scripts/readiness/heavy-admission.mjs`.
2. Change the existing pressure fixture to timestamp-ordered [2, 2, 1]. Assert both the reader's pressure value and the resulting admission decision.
3. Add pressure-only and mixed-reading CLI assertions to the same test file, then add the pressure display branch and correct its precedence comment in the source file.
4. Deliver the two-file fix and its regression evidence together; no queue mechanism, telemetry schema, or threshold changes.

## Test plan

All cases belong in `we:scripts/readiness/__tests__/heavy-admission.test.mjs`, matching the scoped source `we:scripts/readiness/heavy-admission.mjs`.

- Decision: `[null, undefined, 40]` yields idle 40 and admits; all-nullish entries yield null idle and `no-sample` when no other readings exist. `[0]` remains a real low-idle hold. Numeric strings retain the existing conversion behavior.
- Reader: explicit null idle attribute plus busy 63 yields idle 37; missing/null idle plus missing/null busy yields no idle sample; idle 0 overrides a disagreeing busy value; null idle plus busy 0 yields idle 100. Retain the existing absent-attribute and disagreeing-attribute cases.
- Pressure: use [2, 2, 1] at increasing timestamps, assert pressure 1 and `held: false` under defaults. A median implementation would return 2 and hold, so this fixture distinguishes the algorithms.
- CLI: with bypass variables cleared and temporary telemetry, pressure 1 alone prints `admitted — mem pressure 1 (threshold 2)` and JSON retains pressure 1 with null idle/per-core. Pressure 2 still reports its held reason. Admitted idle plus pressure selects idle; admitted pressure plus backstop selects pressure. Retain backstop-only and empty-root assertions. Clean up every temporary directory.

## Proof plan

During implementation, run the new null and pressure-text regressions against the old source first and record the failing assertions. The strengthened pressure fixture should already pass current latest selection; temporarily substitute median selection in an isolated test experiment to prove that fixture fails, then restore the production implementation.

Run the affected suite and standards gate through the host queue. Commands below are executed from the WE root; their path arguments refer to `we:scripts/readiness/heavy-admission.mjs` and `we:scripts/readiness/__tests__/heavy-admission.test.mjs`:

```sh
node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:scripts/readiness/__tests__/heavy-admission.test.mjs
node we:scripts/readiness/heavy-admission.mjs run -- npm run check:standards
```

Capture the failing/passing assertions and CLI output from those fixture-driven subprocess tests. They exercise the actual reader and command without depending on the live host's pressure or changing admission policy. The preparation runner owns preparation checks and stamping; no implementation test pass is claimed here.

## Follow-ups

None required for this bounded prevention debt. Broader numeric-input validation, telemetry retention, and admission-policy changes are outside this item. Any newly observed independent defect should be filed separately with source evidence.
