---
kind: story
size: 3
status: open
scope: ["we:scripts/lib/model-settings.json", "we:scripts/lib/model-settings.mjs", "we:scripts/lib/__tests__/model-settings.test.mjs", "we:scripts/operations/coroner-sample.mjs", "we:scripts/operations/perf-velocity-io.mjs"]
dateOpened: "2026-10-08"
tags: [model-routing, cost, haiku]
---

# Route cheap sampling jobs to Haiku 5.5 as a setting (coroner sample, velocity estimate, prep review advise)

A measured trial (2026-10-08, same inputs, current model vs `claude-haiku-5-5`) found Haiku 5.5 equal on quality for the coroner LLM sample (16/16 schema-valid, same top-2 ranking), the velocity estimate-from-brief (MAE 0.88, bias +0.53, identical) and a light tool-free prep review (recovers 10/10 recorded risks, fewer extras, 10x cheaper, about 3x slower). This item lands them as per-use settings in `we:scripts/lib/model-settings.json` (`coroner.sampleModel`, `velocity.estimateModel`, `prepReview.model`) set to Haiku 5.5, with the code defaults unchanged. Builds, fixes, ci-heals and mandatory review seats are never routable from this file. The results table sits in the operator's 2026-10-08 perf metrics folder (trial results file).

## Done when

1. **Executable** — `npx vitest run we:scripts/lib/__tests__/model-settings.test.mjs` fails before this item (module missing) and passes after: the shipped file resolves all three settings to `claude-haiku-5-5`, the code defaults (`haiku`) are unchanged, and flag > env > setting > default holds for the coroner.
2. **Must** — a group or key outside the three allowed ones (for example `build.model`) is ignored, never honoured.
3. **Must** — on a missing, torn or foreign settings file the jobs fall back to the product default and do not throw.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — a model id must match `^[a-z][a-z0-9.-]{0,63}$`, so a value such as `--bare` can never become an extra CLI flag; bad ids are dropped.
2. **Truncated reads** — a torn JSON file parses to nothing and the product default applies.
3. **Shared state files** — n/a: the settings file is read-only at run time; no job writes it.
4. **Fail closed** — unknown groups and keys are dropped, so a build, fix, ci-heal or review-seat model cannot be set from this file.
5. **Identity scoping** — n/a: one repo-wide file, no per-user scope.
6. **State over time** — estimate and calibration rows record the `model` used; rows from the two models share one store, so a later change of model is visible per row.
7. **Who wrote it** — n/a: the file is hand-edited config in the repo, reviewed like any other change.

## Follow-ups

- `prepReview.model` is read by no code yet: the light advise-mode prep reviewer (held item 125 was a different card) is not built. The builder reads it with `modelSetting('prepReview', 'model', 'sonnet')`.
- Trial caveats: coroner N was 16 (only 16 sessions showed friction in 12 h); the prep replay had only 3 structured recorded risk lists as ground truth.
