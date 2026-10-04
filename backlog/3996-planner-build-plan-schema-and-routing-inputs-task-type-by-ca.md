---
bornAs: xdk2nt2
kind: story
size: 3
parent: "3383"
status: resolved
dateOpened: "2026-09-23"
dateResolved: "2026-10-03"
preparedDate: "2026-09-30"
preparedAgainstSha: "57b54c601b0518cbf3ede27d2e403a489d8d67cf"
scope: ["we:scripts/lib/dispatch-supervisor-contract.mjs", "we:scripts/lib/dispatch-task-type.mjs", "we:scripts/lib/dispatch-contracts.mjs", "we:scripts/conveyor/run-scorecard-store.mjs", "we:scripts/conveyor/__tests__/run-scorecard-store.test.mjs", "we:scripts/lib/__tests__/dispatch-supervisor-contract.test.mjs", "we:scripts/lib/__tests__/dispatch-task-type.test.mjs", "we:scripts/lib/__tests__/dispatch-contracts.test.mjs"]
tags: []
---

# Planner build: plan schema and routing inputs (task type by cause then files, doc allowlist, sizeSource plan)

Child 1 of #3922. Remove the planner-declared taskType from PLAN_OUTPUT_SCHEMA; derive a step type from why it exists (planned, apply clash to conflict-resolution, repair of accepted work to bugfix) then its files; make the doc test an allowlist of reader-facing doc places; make decideDispatchRoute honour sizeSource plan; pass risk through raiseRisk; record new versus modified files and lines on each trial.

## Progress

### Implementation and proof (2026-10-03)

- Removed planner-declared `taskType` and derive profiles using `cause: planned` in we:scripts/lib/dispatch-supervisor-contract.mjs. The shared supervisor task schema also covers newly planned verdict tasks. Existing risk raising remains intact.
- Added planned scope classification and restricted documentation to the explicit reader-facing homes and we:README.md in we:scripts/lib/dispatch-task-type.mjs. Arbitrary Markdown files, lookalike directories and traversal paths do not qualify.
- Preserved `sizeSource: plan` for explicit LOC or supported Fibonacci size, including repair dispatch kinds, in we:scripts/lib/dispatch-contracts.mjs. Missing or invalid plan estimates refuse instead of borrowing a card/default estimate; the audit identifies the planner source.
- Added optional nullable non-negative integer footprint counts (`newLoc`, `modifiedLoc`, `newFiles`, `modifiedFiles`) in we:scripts/conveyor/run-scorecard-store.mjs. Historical rows remain valid; zero and unknown remain distinct.
- **Before:** ran the four affected suites with the new regression assertions against the original implementation: **14 failed, 170 passed**. Failures covered the removed planner field, planned-cause classification, allowlist, plan size provenance and malformed footprint values.
- **After:** the same four suites passed **184/184**. The simulation in we:scripts/lib/__tests__/dispatch-supervisor-contract.test.mjs validates planner JSON, derives doc/code/test types, preserves raised risk and routes with plan size provenance without planner-declared `taskType`. Footprint tests in we:scripts/conveyor/__tests__/run-scorecard-store.test.mjs round-trip null/zero/positive counts and reject malformed counts.
- Standards verification initially caught the Test plan’s existing scorecard test missing from frontmatter scope (#4448). Added we:scripts/conveyor/__tests__/run-scorecard-store.test.mjs to match that declared Test plan; no implementation scope was added.
- **Wider gate:** `node we:scripts/verify-lane.mjs` ran 218 suites: 214 passed, four failed; 9,438 tests passed, 29 failed, eight skipped. Of the failures, 22 are in we:scripts/operations/__tests__/probation-build-run.test.mjs: its invented `we:backlog-docs/` fixture home and arbitrary Markdown assumptions conflict with the required doc allowlist. Updating this out-of-scope caller test needs scope authorization; the allowlist was not broadened to accommodate those fixtures.
- The delivery-wrapper failure identified a legitimate reader-facing file missing from the allowlist: we:README.md. Added that exact filename, preserving the arbitrary-suffix rejection. Reran we:scripts/lib/__tests__/dispatch-task-type.test.mjs and we:scripts/operations/__tests__/deliver-item-wrapper.test.mjs: **279/279 passed**, with no delivery-wrapper edit.
- Six remaining wider-gate failures are real-process probes in we:scripts/operations/__tests__/restart-runner-io-real.test.mjs and we:scripts/operations/__tests__/clear-stuck-session-io-real.test.mjs. A direct `ps` probe also returns `Operation not permitted` in this sandbox. Tests/gates remain intact; this needs verification where process-table access is permitted.
- **Standards recheck:** `npm run check:standards` passed with **0 errors** (5,550 warnings). `git diff --check` passed. Card remains open; the resolve operation has not been run because the wider gate is red.

**Old premise/scope:**
- Remove `taskType` from `PLAN_OUTPUT_SCHEMA`.
- Derive step type from cause (planned, conflict, bugfix) then files.
- Make doc test an allowlist.
- Make `decideDispatchRoute` honour `sizeSource: 'plan'`.
- Pass risk through `raiseRisk`.
- Record new/modified files and lines on each trial.

**Corrected premise/scope:**
- **Already delivered:** `raiseRisk` is already used in `we:scripts/lib/dispatch-contracts.mjs:179` to raise derived risk. "apply clash to conflict-resolution, repair of accepted work to bugfix" is already implemented in `we:scripts/lib/dispatch-task-type.mjs` via `DISPATCH_CAUSES` and `taskTypeFor`.
- **Remaining work:**
  - Remove `taskType` from `PLAN_OUTPUT_SCHEMA`'s task `profile` (`we:scripts/lib/dispatch-supervisor-contract.mjs`).
  - Add `planned` to `DISPATCH_CAUSES` and derive its `taskType` from its `failingFiles`/`scopePaths` in `we:scripts/lib/dispatch-task-type.mjs`.
  - Refine `isDocScopePath` in `we:scripts/lib/dispatch-task-type.mjs` to a strict reader-facing allowlist.
  - Handle `plan` size source in `decideDispatchRoute` (`we:scripts/lib/dispatch-contracts.mjs`).
  - Add `newLoc`/`modifiedLoc` and `newFiles`/`modifiedFiles` (or similar) to `validateScorecard` schema in `we:scripts/conveyor/run-scorecard-store.mjs`.

## Design

- **`PLAN_OUTPUT_SCHEMA`:** Remove `taskType` from `profile`. The planner outputs `filesTouched`, `estimatedLoc`, etc., and the orchestrator derives the `taskType` from the files and cause.
- **Task Type Derivation:** `taskTypeFor` will accept `cause: 'planned'`. If `planned`, it will evaluate the `scopePaths` to return `doc-fix`, `build-new-feature`, or `test-fix` rather than relying on the `kind: 'build'` checks alone.
- **Doc Test:** Narrow `isDocScopePath` to explicitly allowlisted paths (e.g. `docs/`, `src/_data/`, `src/_includes/`) rather than any `.md` file anywhere.
- **Size Source:** `resolveFixSize` or equivalent logic in `decideDispatchRoute` will accept `sizeSource: 'plan'` when a size is provided by the planner instead of the backlog card.
- **Trial Records:** `validateScorecard` in `we:scripts/conveyor/run-scorecard-store.mjs` will be updated to require/allow `newLoc`, `modifiedLoc`, `newFiles`, `modifiedFiles` (nullable or optional) to record detailed change footprint for each trial.

## MVP

- `PLAN_OUTPUT_SCHEMA` does not contain `taskType`.
- `taskTypeFor` correctly maps a `planned` cause to its type based on `scopePaths`.
- `decideDispatchRoute` accepts and records `sizeSource: 'plan'`.
- `we:scripts/conveyor/run-scorecard-store.mjs` schema includes new diff footprint fields.

## Test plan

- Unit tests in `we:scripts/lib/__tests__/dispatch-supervisor-contract.test.mjs` for the schema.
- Unit tests in `we:scripts/lib/__tests__/dispatch-task-type.test.mjs` for `planned` cause and `isDocScopePath` allowlist.
- Unit tests in `we:scripts/lib/__tests__/dispatch-contracts.test.mjs` for `sizeSource: 'plan'`.
- Unit tests in `we:scripts/conveyor/__tests__/run-scorecard-store.test.mjs` (if it exists) or related tests for the new trial fields.

## Proof plan

- A simulated planner output passes validation and is correctly routed with a `planned` cause, its `sizeSource` recorded as `plan`, and its `taskType` correctly derived without being declared in the JSON.

## Follow-ups

- Update the probation caller fixtures in we:scripts/operations/__tests__/probation-build-run.test.mjs once scope is authorized, preserving the out-of-scope and non-documentation rejection assertions. Rerun we:scripts/verify-lane.mjs in an environment permitting real process-table probes; do not skip or weaken those tests.

- Expand planner trials to actually populate the new/modified LOC fields in the scorecard store at execution time (this card only adds the schema fields).
