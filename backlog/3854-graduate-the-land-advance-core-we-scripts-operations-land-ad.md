---
bornAs: xxdbkpr
kind: story
size: 3
parent: "3443"
status: resolved
blockedBy: ["3853"]
scope: ["we:scripts/operations/land-advance.mjs", "we:scripts/operations/land-advance-repair.mjs", "we:scripts/operations/land-advance-escalations.mjs", "we:scripts/operations/__tests__/land-advance-repair.test.mjs", "we:scripts/operations/__fixtures__/land-advance/today.json", "we:scripts/operations/land-advance-items.mjs", "we:scripts/operations/__tests__/land-advance-repair-io.test.mjs"]
dateOpened: "2026-09-21"
dateStarted: "2026-09-24"
dateResolved: "2026-09-24"
tags: []
---

# Graduate the land-advance core (we:scripts/operations/land-advance.mjs plus repair and escalations) from lane/mechanical-dispatcher to main

Graduation slice 5 of 6 for the land-advance operation. Three pure modules missing from main: we:scripts/operations/land-advance.mjs (179 lines, the declared operation, LAND_ADVANCE_OP and OWED_ACTIONS), we:scripts/operations/land-advance-repair.mjs (70) and we:scripts/operations/land-advance-escalations.mjs (34), with their pure tests we:scripts/operations/__tests__/land-advance.test.mjs and we:scripts/operations/__tests__/land-advance-repair.test.mjs and the fixture we:scripts/operations/__fixtures__/land-advance/today.json. Imports checked against origin/main: land-advance imports registry, step-kinds, constellation-repos, lane-concurrency and lane-manifest (all on main, every named import exported); escalations imports hiccup-classify (on main). It needs NOTHING from the watchdog, session-verdicts or ci-heal slices, only the land-advance-tools slice. Registration in we:scripts/operations/run.mjs stays in the last slice.

## Done when

1. **Executable** — `npx vitest run we:scripts/operations/__tests__/land-advance.test.mjs we:scripts/operations/__tests__/land-advance-repair.test.mjs` passes ON `main` after the port (the branch runs 84 tests across all six land-advance files; these two are the pure ones), and `git diff origin/main...origin/lane/mechanical-dispatcher -- we:scripts/operations/land-advance.mjs we:scripts/operations/land-advance-repair.mjs we:scripts/operations/land-advance-escalations.mjs we:scripts/operations/__tests__/land-advance.test.mjs we:scripts/operations/__tests__/land-advance-repair.test.mjs we:scripts/operations/__fixtures__/land-advance/today.json` reports nothing.
2. `npm run check:standards` reports 0 errors. The declaring module is not registered in `we:scripts/operations/run.mjs` yet, so `we:scripts/operations/__tests__/http-adapter.test.mjs` needs no pin here; confirm that by running it, and if it fails on the unregistered module, move that one pin from the IO slice to this one and say so.
3. Landed as its own PR through the normal lane → `we:scripts/verify-lane.mjs` → `we:scripts/operations/run.mjs open-pr --mode=land` pipeline, never a direct push, and never before the `blockedBy` slice above.

## Order and port notes

- Part of the six-slice land-advance graduation under #3443. **CORRECTION to the inventory:** it lists this slice as depending on the watchdog, session-verdicts and ci-heal slices. Checked import by import, this slice needs only the land-advance-tools slice: `we:scripts/operations/land-advance.mjs` and its escalations module import nothing from those three, and the two pure tests import only these modules, the tools module and `we:scripts/lib/constellation-repos.mjs`. The dependency runs the other way: the session-verdicts slice needs this one.
- Order across the six: tools (2) → this slice (5) → session-verdicts (3); watchdog (1) and ci-heal (4) are independent; IO and wiring (6) last.
- Under the #3804 statute (`we:docs/agent/platform-decisions.md#poc-branch-mechanical-sync`) a graduation slice ports a file main has moved AS A DIFF and is exempt from the drift hold. Shared modules that exist on `main` with a different body and that this slice imports from: `we:scripts/lib/constellation-repos.mjs` and `we:scripts/readiness/lane-manifest.mjs`. Do NOT overwrite either with the branch copy. Every named import this slice takes from them is already exported on `main` (checked name by name), so no hunk of them should be needed; if a test disagrees, diff-merge only the hunk it needs and name it in the PR.

## Step 0 re-plan (2026-09-22)

Moved `we:scripts/operations/land-advance-items.mjs` (17 lines, pure) into this slice from #3865: `we:scripts/operations/land-advance.mjs` imports it, so without it this slice could not pass the gate on main while #3865 waits.

## Graduation import check

- 2026-09-24: graduation-import-check moved `we:scripts/operations/__tests__/land-advance.test.mjs` to #3865 — it imports a module #3865 owns.
