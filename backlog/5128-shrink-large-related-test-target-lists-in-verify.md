---
bornAs: x25udmp
kind: story
size: 3
status: open
scope: ["we:scripts/verify-lane.mjs", "we:scripts/lib/verify-lane-gate.mjs", "we:scripts/lib/related-test-selection.mjs", "we:scripts/lib/verify-settings.mjs", "we:scripts/verify-settings.json"]
dateOpened: "2026-10-05"
tags: []
---

# Shrink large related-test target lists in verify

Fixer and ci-heal verifies ran vitest related on ~70 target files although the diffs were 5-16 files. Cause: literal-reference discovery plus the related graph pulling in every test touching widely shared core modules (guard-bash, jury-core). Consider caching the related-test set by file content, or sharding core-module verifies into one heavy slot each.

## Re-measured 2026-10-06 (just-in-time prepare)

Literal-reference discovery is gone from the daemon path (`relatedMode: import-only`, every recent marker shows `literal 0`), so `targets` now equals the changed files. The fan-out is inside `vitest related` itself: it walks the reverse-import graph to any depth. On 7 real lane diffs from today, the changed files reached 87-485 test files, while only 3-46 tests import a changed file directly. Example: lane-18 changed one source file (we:scripts/conveyor/health-responder-state.mjs); 3 tests import it, 89 are reachable, and the gate spent 840 s in vitest.

## Rule

Over `relatedMaxTests` (settings file: 40) reachable tests, the gate runs an explicit `vitest run` list: changed test files plus every test within `relatedDepth` (2) import hops, dropping one hop at a time down to 1 while still over the limit. Tests that import a changed file directly always run. The marker's `phases.selection` records `status: selection-truncated`, the full and selected counts, the depth used and the hub files. Under the limit, the gate is unchanged (`vitest related`). CI still runs the full suite on every PR.

## Done when

1. **Executable** — `npx vitest run we:scripts/lib/__tests__/related-test-selection.test.mjs we:scripts/lib/__tests__/verify-lane-gate.test.mjs` (paths without the `we:` prefix) fails before this item lands and passes after.
2. **Must** — on any graph error, a missing reader, an empty list or an over-long command line, the gate keeps plain `vitest related` (never a smaller run, never a full suite).
3. **Must** — a test that imports a changed file directly is never dropped.
