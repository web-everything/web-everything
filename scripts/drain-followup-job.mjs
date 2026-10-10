#!/usr/bin/env node
/**
 * @file scripts/drain-followup-job.mjs
 * @description #4124 — the `drain-followup` job child. Launched DETACHED by the job runtime
 *   (we:scripts/lib/daemon-jobs-runtime.mjs) inside the kind's own linked worktree of `main`, with
 *   `DAEMON_JOB_ID` / `DAEMON_JOB_ATTEMPT` / `OPERATION_RUNS_DIR` set. It claims its record, runs the
 *   follow-up steps (we:scripts/lib/drain-followup-job.mjs) from the record's checkpoint, and exits. Never run
 *   by hand: without the job env it refuses and exits 1.
 */
import { execFileSync } from 'node:child_process';

import { runJob } from './lib/daemon-jobs-runtime.mjs';
import { followupSteps } from './lib/drain-followup-job.mjs';
import { numberPendingHashes, resolveLandedItem } from './lane-drain.mjs';
import { planResolveOnLand, pushNumberingOnLand, regenDerivedOnLand, syncPrimaryOnLand } from './merge-ai-prs.mjs';
import { withNumberingLock } from './readiness/drain-lock.mjs';

const steps = followupSteps({
  cwd: process.cwd(), exec: execFileSync, numberPendingHashes, resolveLandedItem, planResolveOnLand,
  pushNumberingOnLand, regenDerivedOnLand, withNumberingLock, syncPrimaryOnLand,
});
const out = await runJob({ steps });
console.log(`${new Date().toISOString()} drain-followup pid=${process.pid} ${JSON.stringify(out)}`);
process.exit(out.outcome === 'succeeded' ? 0 : 1);
