#!/usr/bin/env node
/**
 * @file fixtures/prevention-card-noop-job.mjs — #4075 soak harness fixture for
 * `breaks/prevention-card-lands-in-daemon-clone.mjs`. A harmless stand-in for the REAL detached landing job
 * (`we:scripts/operations/land-prevention-card.mjs`): the break's probe substitutes this path for `runScript`
 * on historical trees, or at the OS spawn seam after the diagnostic target check on current trees,
 * so `fileApprovalPreventionCard`'s own REAL detached primitive still spawns a genuine child process
 * (proving the fixed code really hands off, not merely mocks the hand-off away) — while that child does
 * nothing, immediately, rather than actually acquiring a lane and running the full file-item/verify/open-pr
 * sequence in the background (which is `land-prevention-card.test.mjs`'s own, separate, concern).
 */
process.exit(0);
