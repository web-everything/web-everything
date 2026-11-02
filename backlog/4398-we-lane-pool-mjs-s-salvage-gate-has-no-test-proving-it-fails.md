---
bornAs: xycb80x
kind: task
parent: "4075"
status: open
blockedBy: ["4273"]
scope: ["we:scripts/__tests__/lane-pool-salvage-gate.test.mjs"]
estimatedLoc: 85
dateOpened: "2026-09-28"
preparedDate: "2026-11-01"
preparedAgainstSha: "2097ddbd864cdede244e153e59d664bc8082aef5"
tags: []
---

# Salvage gate needs regression coverage for a throwing content-mtime read

The remaining goal is to exercise the production gate used by `cmdReclaimSalvage` when `newestContentMtimeMs` throws, proving the lane is not quiet. The exported `laneLivenessGate` in we:scripts/lib/lane-salvage.mjs:371 is now that seam; we:scripts/lane-pool.mjs:4622 calls it before salvage and again under the reclaim hold. Add a regression against this actual seam rather than another reconstruction of eligibility logic.

## Acceptance

[A1] **Executable** — From the WE repository, run `node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:scripts/__tests__/lane-pool-salvage-gate.test.mjs` (strip the `we:` locus prefixes when executing). The new test `mtime read failure refuses the production salvage gate at the default quiet period` must demonstrate a real `newestContentMtimeMs` exception, then assert the actual `laneLivenessGate` returns `eligible: false` with a quiet-period reason. Use empty agent/process readers and no lease so another guard cannot satisfy the assertion. Before implementation the named test file is absent and the command fails; after implementation it passes. Removing the production catch fallback must also fail this test.

[A2] **Executable** — The same queued command runs `readable old content is eligible through the same production gate`. With the same fixture repaired and its content timestamps older than the default quiet window, assert `eligible: true`. This positive control prevents an always-refuse fixture from passing A1. The named test is absent before implementation and passes afterward; mutating the gate to always refuse must fail it.

## Design

Use the existing exported seam, without changing production interfaces, callers, settings, or defaults. The production catch at we:scripts/lib/lane-salvage.mjs:394 converts an exception to `nowMs`; eligibility rejects that value for a positive quiet window at we:scripts/lib/lane-salvage.mjs:155. The default is the behavior under test. Explicit zero quiet time is outside this guarantee: zero elapsed is not less than zero, so this item must not claim unconditional refusal for that override or change its policy.

Create we:scripts/__tests__/lane-pool-salvage-gate.test.mjs with a disposable local Git repository under the task temporary directory. Make the worktree-litter root (the lane-relative `.claude/worktrees` location) a regular file: the directory read in we:scripts/lib/lane-salvage.mjs:264 then throws deterministically, including under privileged test users. Assert the actual mtime reader throws before calling the production gate. This avoids permission-dependent skipped tests and avoids mocking or reimplementing the catch.

For the positive control, remove the malformed root, keep readable content, and use a fixed `nowMs` sufficiently beyond all fixture mtimes. Stub only the existing agent and cwd reader inputs with empty arrays. Clear and restore `WE_LANE_SALVAGE_QUIET_MIN` so ambient configuration cannot replace the real default. Always remove fixtures and restore environment in teardown. No remote operations or real pool access are needed.

## MVP

Must: add the two named tests, assert a genuine reader exception and the production seam's refusal reason, and establish the readable/old positive control. This is a test-only change using the already-exported seam expressly allowed by the original goal. Existing callers remain unchanged: direct reclaim at we:scripts/lane-pool.mjs:4497 and we:scripts/lane-pool.mjs:4570, salvage reclaim at we:scripts/lane-pool.mjs:4622, and the health watcher at we:scripts/conveyor/lane-pool-health-watch.mjs:345.

Could: add a separate CLI test for refusal after the temporary hold is acquired. That broader orchestration coverage is not required to prove this catch composition and is deferred below.

## Test plan

Run the queued command in Acceptance with repository prefixes removed. Verify both tests actually execute, with no permission-based skips. A1 must reach the mtime read with valid lease absence and readable liveness evidence; A2 must use the same exported gate and default configuration. Assert the original fixture content remains unchanged after the gate call. Keep all scratch fixtures under the task temporary directory and restore the environment even on assertion failure.

The runner owns preparation checks. During implementation, run only the new affected test through the heavy queue; run the standards check through that queue as required. If admission is busy, use its supported bounded wait once and then report, without polling.

## Proof plan

Capture the missing-file failure before adding the test, then the passing two-test run. For meaningful regression sensitivity, temporarily replace the catch assignment at we:scripts/lib/lane-salvage.mjs:394 with a null value: A1 must fail because eligibility would become true. Restore the source immediately. Temporarily force an ineligible result: A2 must fail. Restore the source and obtain a final green run. These are implementation-time local mutations, never changes to ship or actions for this preparation worker.

Record exact test names, command results, and mutation failures. Do not claim CLI-level reset/lease cleanup coverage from a seam test; the observation proves the real caller's shared gate classifies the lane as not quiet.

## Follow-ups

Optional separate work: exercise both salvage CLI gate invocations, including a read failure introduced between the initial check and the under-hold check, and verify temporary lease cleanup and absence of salvage/reset side effects. Any policy change for the explicit zero quiet-time override needs its own scope; this task preserves that behavior.

## Progress

- Original premise/scope: an unexported inline catch in we:scripts/lane-pool.mjs, no reclaim coverage, and only that production source in scope. Corrected premise: the catch is now in the exported `laneLivenessGate` at we:scripts/lib/lane-salvage.mjs:371–395, and the salvage caller delegates at we:scripts/lane-pool.mjs:4622 before checking eligibility at we:scripts/lane-pool.mjs:4624 and we:scripts/lane-pool.mjs:4649. Existing reclaim integration coverage lives in we:scripts/__tests__/lane-pool-reclaim.test.mjs; its fixture explicitly zeroes the quiet window at we:scripts/__tests__/lane-pool-reclaim.test.mjs:83. Thus zero existing coverage of reclaim is no longer accurate.
- The remaining gap is the throwing-mtime composition with a positive/default quiet window. Existing gate tests at we:scripts/lib/__tests__/lane-salvage.test.mjs:111 cover owner/process readers; the litter failure test at we:scripts/lib/__tests__/lane-salvage.test.mjs:459 checks reader/salvage exceptions, while we:scripts/lib/__tests__/lane-salvage.test.mjs:503 reconstructs eligibility rather than calling the production gate. Neither substitutes for A1.
- Corrected scope is one planned matching test file, we:scripts/__tests__/lane-pool-salvage-gate.test.mjs; no production extraction is needed. Estimate: one file × approximately 85 changed lines (imports/setup/cleanup 35, exception/refusal case 30, readable positive control 20), hence `estimatedLoc: 85`. No previous size or line estimate was present. Existing source references are evidence, not planned edits.
- Caller inspection also found shared use by the health watcher at we:scripts/conveyor/lane-pool-health-watch.mjs:345. No default or caller changes are proposed. No implementation tests were run during this card-only preparation; stamping and checks remain with the runner.
