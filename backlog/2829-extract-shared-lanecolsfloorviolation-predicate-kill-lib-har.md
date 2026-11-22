---
bornAs: xph9va4
kind: story
size: 2
tier: pinned
parent: "2804"
status: parked
parkedReason: maturityGated
maturityTrigger: "adoptionSignal: #2811 is unparked (shared floor predicate)."
dateParked: "2026-11-22"
dateOpened: "2026-08-02"
blockedBy: ["2810"]
scope:
  - plateau-app:scripts/dev/fidelity-render.mjs
  - plateau-app:tests/visual/geometry-theme.ts
tags: [plateau-loop, conveyor, ui-fidelity, plateau-app, slice-uifg, tech-debt]
deliveryAgent: codex
deliveryAgentReason: "astra graduation trial (epic #3383/#4034/#3906): non-critical per the #4034/#2752 critical-work rule — a pure, behavior-preserving DRY refactor in plateau-app test/harness code with an exact prescribed diff and complete Done-when; the 'conveyor'/'slice-uifg' tags name plateau's own UI-fidelity-gate feature area, not the WE conveyor/gate machinery the critical-work rule targets, and no scope path matches it; operator-directed, 2026-09-26"
---

# Extract shared laneColsFloorViolation predicate — kill lib/harness grid-collapsed floor drift

The #2810 lib (`plateau-app:tests/visual/geometry-theme.ts`) re-implements the `grid-collapsed` floor
inline in `assertMultiLaneGrid` with default `minCols = 2`, while the #2809 harness grades the same floor in
`gradeReport` (`plateau-app:scripts/dev/fidelity-render.mjs`) against the contract's per-regime `minLaneCols`
of **3**. Two copies of one rule with different default floors is a latent divergence — safe today only
because the #2811 spec passes `minCols` explicitly. Fix: extract one shared `laneColsFloorViolation(laneCols,
minCols)` predicate into the harness and import it in the lib, the same reverse-extraction the lib already
uses for `cellGeometryViolations` and `themeCascadeViolations`, so lib and harness can't drift on the default.

**`blockedBy: ["2810"]` is resolved** (`dateResolved: "2026-08-02"`) — this item is unblocked; the edge is kept
for lineage per the backlog-workflow convention (a resolved blocker still leaves the item Tier A).

## Verified against live code (2026-08-15)

The two independent copies are real and confirmed at the cited lines — **but the framing above ("default 2
vs default 3") conflates two different things**, corrected here so a builder doesn't chase the wrong fix
(picking "the right" single default; there isn't one — different regimes legitimately need different floors).

- **Lib copy** — `plateau-app:tests/visual/geometry-theme.ts:116` and `plateau-app:tests/visual/geometry-theme.ts:120-121`, inside `assertMultiLaneGrid`:
  ```ts
  const minCols = opts.minCols ?? 2;
  ...
  if (laneCols < minCols)
    out.push({ code: 'grid-collapsed', detail: `${laneCols} full lane columns (min ${minCols}) — the multi-lane grid collapsed to strips / a starved centre` });
  ```
  `opts.minCols` defaults to **2** when the caller doesn't pass one.

- **Harness copy** — `plateau-app:scripts/dev/fidelity-render.mjs:167-168`, inside `gradeReport`:
  ```js
  if (exp.minLaneCols != null && s.laneCols < exp.minLaneCols)
    violations.push({ ...where, code: 'grid-collapsed', detail: `${s.laneCols} full lane columns (min ${exp.minLaneCols}) — the multi-lane grid collapsed to strips / a starved centre` });
  ```
  This has **no hardcoded default at all** — `exp.minLaneCols` comes straight from the contract data
  (`plateau-app:tests/fidelity/console-board.contract.mjs:74-75`: `populated: minLaneCols: 3`,
  `overflow: minLaneCols: 1`; `empty` sets none, so the check is **skipped** for that regime). "The harness
  grades against 3" is only true for the `populated` regime — it is data-driven, not a second hardcoded
  constant.

  **The real hazard is not "2 vs 3."** It's that the SAME comparison (`laneCols < minCols`, same `code:
  'grid-collapsed'`, same detail-string template) is written out twice by hand. A future edit to one — a
  tolerance, an off-by-one fix, a wording change — has no way to reach the other. That's the DRY risk this
  item exists to close, exactly as the provenance note (PR #133 review) describes it.

  A third caller was found and checked — it does **not** re-implement the comparison, so it is out of scope:
  `plateau-app:tests/fidelity/real-route-conformance.ts:162-163` sets its own fallback
  (`conf.regimes[c.seed]?.minLaneCols ?? 2`) but then calls `assertMultiLaneGrid(c.signals, { minCols })` —
  it delegates to the lib rather than re-checking `laneCols < minCols` itself, so extracting the shared
  predicate leaves this call site correct with **no changes required**.

## Decided design

Extract `laneColsFloorViolation(laneCols, minCols)` into the harness
(`plateau-app:scripts/dev/fidelity-render.mjs`), next to the two existing single-owner predicates
(`cellGeometryViolations`, `themeCascadeViolations`, same file, roughly lines 184-221). It is a **pure
comparison**, not a policy: it takes the already-resolved `minCols` and returns one violation or `null` — it
does **not** choose a default or a skip-when-missing rule. Each of the two callers keeps its own policy
exactly as today:

- `gradeReport` keeps skipping the check when `exp.minLaneCols` is `null`/unset (the `empty` regime).
- `assertMultiLaneGrid` keeps defaulting to `minCols = 2` when `opts.minCols` is unset.

This is the same reverse-extraction shape already used for `cellGeometryViolations` and
`themeCascadeViolations`: the harness owns the one definition (it must stay TS-free / browser-free per the
lib's own header comment, `plateau-app:tests/visual/geometry-theme.ts:9-12`, so the harness cannot import
*from* the `.ts` lib — the lib imports from the harness, never the reverse), and the lib imports + re-exports
it as part of its typed public surface. No behavior change for either caller; this is a pure refactor.

## Interfaces

New export, `plateau-app:scripts/dev/fidelity-render.mjs` (placed beside `cellGeometryViolations` /
`themeCascadeViolations`):
```js
/**
 * Lane-columns floor: fewer than `minCols` full lane columns is a collapsed grid (strips / a starved
 * centre). EXPORTED (#2829): the SINGLE definition of this comparison — `gradeReport` here and the typed
 * lib's `assertMultiLaneGrid` (`../../tests/visual/geometry-theme.ts`) both call it, so they cannot drift on
 * what "collapsed" means. Takes the already-resolved `minCols`; callers own their own default/skip policy.
 * @param {number} laneCols
 * @param {number} minCols
 * @returns {{code: 'grid-collapsed', detail: string} | null}
 */
export function laneColsFloorViolation(laneCols, minCols) {
  if (laneCols < minCols)
    return { code: 'grid-collapsed', detail: `${laneCols} full lane columns (min ${minCols}) — the multi-lane grid collapsed to strips / a starved centre` };
  return null;
}
```

Call site 1 — `gradeReport`, replacing the inline check at `plateau-app:scripts/dev/fidelity-render.mjs:167-168`:
```js
if (exp.minLaneCols != null) {
  const v = laneColsFloorViolation(s.laneCols, exp.minLaneCols);
  if (v) violations.push({ ...where, ...v });
}
```

Call site 2 — `plateau-app:tests/visual/geometry-theme.ts:31`, add to the existing import from the harness:
```ts
import { gradeReport, cellGeometryViolations, themeCascadeViolations, integrityDigest, laneColsFloorViolation } from '../../scripts/dev/fidelity-render.mjs';
```

Call site 2b — `assertMultiLaneGrid`, replacing the inline check at `plateau-app:tests/visual/geometry-theme.ts:120-121` (keep the `minCols` default at `plateau-app:tests/visual/geometry-theme.ts:116` as-is; only the comparison moves):
```ts
const v = laneColsFloorViolation(laneCols, minCols);
if (v) out.push(v as Violation);
```

Re-export — `plateau-app:tests/visual/geometry-theme.ts:172-174`, add `laneColsFloorViolation` to the existing
re-export list for parity with `cellGeometryViolations`/`themeCascadeViolations` (both already re-exported
there as the lib's typed public surface):
```ts
export { gradeReport, cellGeometryViolations, themeCascadeViolations, laneColsFloorViolation, integrityDigest };
```

No signature changes to `gradeReport`, `assertMultiLaneGrid`, or `assertGeometryAndTheme` — every existing
consumer (`plateau-app:tests/fidelity/real-route-conformance.ts`, `plateau-app:tests/visual/real-route-fidelity.spec.ts`,
`plateau-app:tests/fidelity/real-route-fidelity.test.ts`) keeps calling the same public functions unchanged.

## Tasks

1. Add `laneColsFloorViolation(laneCols, minCols)` to `plateau-app:scripts/dev/fidelity-render.mjs`, exported,
   placed beside `cellGeometryViolations`/`themeCascadeViolations` with a matching "EXPORTED (#2829): SINGLE
   definition" doc comment.
2. Replace the inline `grid-collapsed` check inside `gradeReport` (`plateau-app:scripts/dev/fidelity-render.mjs:167-168`)
   with a call to the new predicate, preserving the existing `exp.minLaneCols != null` skip.
3. Add `laneColsFloorViolation` to the harness import in `plateau-app:tests/visual/geometry-theme.ts:31`.
4. Replace the inline `grid-collapsed` check inside `assertMultiLaneGrid` (`plateau-app:tests/visual/geometry-theme.ts:120-121`)
   with a call to the imported predicate, keeping the `opts.minCols ?? 2` default untouched at
   `plateau-app:tests/visual/geometry-theme.ts:116`.
5. Add `laneColsFloorViolation` to the lib's re-export block (`plateau-app:tests/visual/geometry-theme.ts:172-174`).
6. Run `npm test` (plateau-app vitest) — no test file needs to change; both existing regression cases already
   exercise the extracted code path end to end: the harness side
   (`plateau-app:tests/fidelity/fidelity-render.test.ts:58-69`, `'RED-flags the known-bad console-board'`,
   asserts `grid-collapsed` from `gradeReport`) and the lib side
   (`plateau-app:tests/fidelity/geometry-theme.test.ts:59-73`, `'assertMultiLaneGrid — the collapsed-grid
   guard'`, all three cases). If either fails post-refactor, the extraction changed behavior — fix the
   predicate, not the tests.
7. Confirm no third inline copy of the comparison was left behind — a repo-relative search for `laneCols <`
   under `plateau-app:scripts/dev/` and `plateau-app:tests/visual/` should show exactly one hit (inside
   `laneColsFloorViolation` itself).

## Done when

- [ ] `laneColsFloorViolation(laneCols, minCols)` is defined exactly once, in
      `plateau-app:scripts/dev/fidelity-render.mjs`, and exported.
- [ ] `gradeReport`'s `grid-collapsed` violation is produced by calling `laneColsFloorViolation` — no inline
      `s.laneCols < exp.minLaneCols` comparison remains in `plateau-app:scripts/dev/fidelity-render.mjs`.
- [ ] `assertMultiLaneGrid`'s `grid-collapsed` violation is produced by calling the SAME imported
      `laneColsFloorViolation` — no inline `laneCols < minCols` comparison remains in
      `plateau-app:tests/visual/geometry-theme.ts`.
- [ ] A repo-relative search for `laneCols <` across both files returns exactly one match (inside the new
      predicate).
- [ ] `plateau-app:tests/fidelity/fidelity-render.test.ts` (`'RED-flags the known-bad console-board'`, line
      ~59) passes UNMODIFIED, still asserting `codes` contains `grid-collapsed`.
- [ ] `plateau-app:tests/fidelity/geometry-theme.test.ts` (`'assertMultiLaneGrid — the collapsed-grid guard'`,
      lines 59-73) passes UNMODIFIED — all three cases (RED on today's board, single-column default-`minCols`
      flag, GREEN on a faithful 3-column render).
- [ ] `npm test` (plateau-app vitest, the required `test` check) is green.
- [ ] `laneColsFloorViolation` is re-exported from `plateau-app:tests/visual/geometry-theme.ts`, matching how
      `cellGeometryViolations` and `themeCascadeViolations` are already re-exported there.

## Delivery shape

**One PR, both files in the same commit.** The `plateau-app:tests/visual/geometry-theme.ts` import (task 3)
only resolves once `plateau-app:scripts/dev/fidelity-render.mjs` exports the new symbol (task 1) — the two
files are coupled at the module boundary, so this cannot land as two independent increments behind `main`. It
is otherwise a small, mechanical, behavior-preserving refactor confined to `plateau-app`; no `web-everything`
code changes.

## Provenance

Introspection capture from the independent review of plateau-app PR #133 (the #2810 geometry+theme lib). Not
a live defect — a DRY hazard surfaced while the reviewer traced why the lib and the harness both own a
`grid-collapsed` code path. Filed so the third shared predicate lands the same way the first two did.

Parked 2026-11-22 (plateau ruling, master plan). Unpark when: #2811 is unparked (shared floor predicate).
