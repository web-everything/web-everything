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

The tests pin the engine to a baseline captured from the page (`__tests__/fixtures/baseline-C3.json`, to 1e-9)
and check purity, the clock-as-input rule and migration of older saved states. If the engine's numbers change
on purpose, regenerate the baseline fixture in the same change.

The baseline was captured in `America/Toronto` local time. The suite pins that timezone in an isolated
Vitest fork, since the engine's local-midnight date arithmetic spans daylight saving transitions. Both
the captured day and timezone are fixed inputs, independent of the CI host's clock and timezone.
