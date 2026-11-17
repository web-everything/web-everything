# Longshore sim-engine

The delivery simulator's engine: a pure ES module (`engine.mjs`) with no DOM, storage, network or clock
reads. It has no imports at all.

- **Inputs:** plain data. A settings/state object (`presetToday()`, `migrate(saved)`), a project-settings
  snapshot passed once through `setPS(...)`, and a `today` date handed to `ensurePlan(state, today)`.
- **Outputs:** plain data. The capacity model (`compute`), the plan at a date (`ptRun`, `ptStateAt`), the
  placed just-in-time levers and milestone dates, Forge B effects and token bind days.
- **Consumers:** the public simulator page and plateau-app (P3) will both import this one file.

This package is canonical. The simulator build (owned by the Simulator session) should inline from here
instead of keeping its own copy, so the two cannot drift.

## Tests

`npm run test:unit -- packages/longshore/sim-engine/__tests__/engine.test.mjs`

The tests pin the engine to a baseline (v30.3-D.3, identical to D.2, pinned today 2026-11-16) captured from the page (`__tests__/fixtures/baseline-D3.json`, to 1e-9)
and check purity, the clock-as-input rule and migration of older saved states. If the engine's numbers change
on purpose, regenerate the baseline fixture in the same change.

The baseline was captured in `America/Toronto` local time. The suite pins that timezone in an isolated
Vitest fork, since the engine's local-midnight date arithmetic spans daylight saving transitions. Both
the captured day and timezone are fixed inputs, independent of the CI host's clock and timezone.

## Change map (v30.3-D.1 to D.3)

- **D.1, the clock is an input.** `newPlan(base, today)` and `ensurePlan(state, today)` throw without `today`;
  `hooks.stamp` supplies the milestone-id suffix. Plan context is explicit (`pl._cx = {cum}`, `ptTrialOf`,
  `getCum`, `ptSampleOf(..., pl)`); `ptPlCur`, `setPlCur` and `keepCtx` are removed. New exports: `ptCx`,
  `ptCumTable`, `ptTrialOf`, `ptTodayIso`.
- **D.1, audit fixes.** The seat add clamps on the result; a zero-slot heavy-mac pool means no local heavy runs;
  `provQuota` fails closed on a malformed quota (default used, warning raised); 0 GB free disk means full, not
  unlimited; `holdTerms` scales the queue rows.
- **D.2.** `ptJitPlace` keeps token moves; `ptLateStrat`; the `ptSettle` late-pass loop (max 4); new export
  `ptSuggestFinish`.
- **D.3.** `newPlan` always seeds `m-studio` and `m-daemons` at max(real date, start), with real dates
  2026-11-17 and 2026-11-19. This fixes the plan collapse from start day Nov 20 onward.
- **Tests.** The 21 cases of the Simulator's Node suite are ported, plus the start-day sweep
  (2026-11-15 to 2026-12-31) in the D.3 case.
