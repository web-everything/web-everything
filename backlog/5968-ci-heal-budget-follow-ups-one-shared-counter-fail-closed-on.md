---
bornAs: xwfvby0
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor/ci-heal-mark.mjs", "we:scripts/conveyor/reconcile-core.mjs", "we:scripts/conveyor/tick-core.mjs", "we:scripts/operations/land-advance-io.mjs", "we:scripts/conveyor/__tests__/ci-heal-mark.test.mjs", "we:scripts/conveyor/__tests__/ci-heal-attempts.test.mjs", "we:scripts/conveyor/__tests__/reconcile-core.test.mjs", "we:scripts/conveyor/__tests__/tick-core.test.mjs", "we:scripts/operations/__tests__/land-advance-io.test.mjs"]
dateOpened: "2026-10-12"
preparedDate: "2026-10-14"
preparedAgainstSha: "6742d1202f2de0350e0a5a6978cebaa385be8b43"
tags: []
---

# CI-heal budget follow-ups: one shared counter, fail closed on bad timestamps

Apply the existing fix-head reset rule consistently across reconcile, tick and landing repair evidence, without refunding attempts whose timestamps cannot be established. Preserve attributed-main refunds, CodeQL accounting and the ordinary fix-round cap.

## Progress

- Original premise said tick and landing count every heal. Corrected: all three already use the shared chargeable counter in we:scripts/conveyor/ci-heal-mark.mjs:149, including attributed-main refund windows. Tick calls it at we:scripts/conveyor/tick-core.mjs:2162 and landing at we:scripts/operations/land-advance-io.mjs:152. Only reconcile additionally applies the fix-head reset.
- The reset helper and filter now live at we:scripts/conveyor/reconcile-core.mjs:521 and :552, used at :1981. The filter drops a heal with missing/invalid `createdAt` because the NaN comparison is false. This is distinct from attributed-window filtering, which already retains such an attempt.
- Broaden source scope to the existing shared counter module, and add all matching tests. Existing reset/cascade coverage is in we:scripts/conveyor/__tests__/ci-heal-attempts.test.mjs:60 and :128; extend it rather than duplicate it under another name.
- Size changes from 2 to 3: approximately 90 lines moved/adapted in the shared module, 80 removed/adapted in reconcile, 35 each in tick and landing, plus about 150 regression lines across five test files. Tick's in-memory overlay at we:scripts/conveyor/tick-core.mjs:896 is part of the work: sharing only the durable count would leave old attempts blocking a reset or repeatedly refund them.

## Design

Move the pure budget-policy resolver, reset recognition and timestamp filtering into we:scripts/conveyor/ci-heal-mark.mjs and expose one budget-evidence calculation returning the filtered chargeable count, reset identity and refund diagnostics. Re-export existing public budget/reset helpers from reconcile for compatibility. Keep policy resolution at callers and pass the resolved reset/restore/reason options; do not import reconcile into the shared module.

A heal is removed by a fix-head reset only with a valid timestamp at or before a valid trusted reset. Missing/invalid timestamps stay charged; unknown reason remains chargeable under CodeQL filtering. Keep non-heal comments so attributed-window evidence survives. Invalid reset evidence yields no reset.

Use the same evidence calculation in all three callers. In tick, associate the volatile attempt overlay with the reset identity, consuming a proven reset only once and retaining launches after that reset. Preserve outstanding live-worker guards and the durable floor on restart. An unattributable volatile attempt is retained, not guessed to predate a reset. Preserve existing explicit cap precedence and fix-round refusal paths; this is consistency of the already-enabled reset rule, not a new retry allowance.

## MVP

Share the reset-aware calculation, integrate the three readers, make timestamp handling conservative, and reconcile the volatile overlay with a proven reset exactly once. Keep existing settings defaults, attempt markers and deduplication.

## Test plan

Extend we:scripts/conveyor/__tests__/ci-heal-mark.test.mjs and we:scripts/conveyor/__tests__/ci-heal-attempts.test.mjs with before/equal/after reset timestamps, absent/invalid timestamps, invalid reset dates, untrusted/unchanged/CI-heal fix markers, duplicate attempt IDs, reset disabled, and attributed windows combined with reset and CodeQL reason filtering.

Use we:scripts/conveyor/__tests__/reconcile-core.test.mjs for explicit `ciHealCap` precedence including zero, CodeQL-path reset wiring, fix/heal alternation reaching the existing fix cap, and an older failed check superseded by a newer success. Add matching injected histories in we:scripts/conveyor/__tests__/tick-core.test.mjs and we:scripts/operations/__tests__/land-advance-io.test.mjs. Tick cases must include two consecutive polls after one reset, a new launch between polls, an outstanding worker, and restart with durable evidence; no double refund. Run the five scoped suites through the host heavy-admission queue.

## Proof plan

Replay one identical trusted PR history through the three evidence readers with identical policy options. Record equal chargeable counts and reset identity, then append an undated heal and show every reader charges it. Run a two-tick replay proving the reset is consumed once and a subsequent launch remains spent. Exercise the existing fix cap with alternating heals and real fixer heads; no live dispatch or state writes are required.

## Acceptance

All three paths honor the same proven reset and count malformed-time attempts conservatively. No repeat refund across ticks, no lost post-reset attempt, and no bypass of the fix-round cap or explicit caller cap.

## Non-goals

No changes to cap values, CodeQL's separate-budget policy, author allowlists, marker formats, or required-check ownership.

## Edge cases

Untrusted markers cannot reset a budget. Missing chronology retains charges. Existing dedupe identity and PR boundaries remain intact. No new shared file is needed; volatile overlay bookkeeping lives in existing tick state. A new head alone is insufficient without the existing trusted fixer evidence. No receive endpoint is introduced.

## Follow-ups

If replay exposes a separate failure-selection or fix-cap defect, isolate it with the failing fixture before expanding scope; do not change cap policy to make the test pass.
