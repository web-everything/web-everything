/**
 * @file breaks/rebuild-lease-reused-pid.mjs — live break, 2026-11-01 on `wev-review-daemon` (R372). A rebuild's
 * build lease was held by a pid that had since died; the OS reused the pid for a live, UNRELATED pass-daemon
 * (lease-reaper etc.). `buildLeaseIsLive` only asked "does the pid exist?", so the dead lease stayed live and the
 * rebuild kept deferring to a build that no longer existed.
 *
 * Fix: `buildLeaseIsLive` also compares the pid's process start time (`ps -o lstart=`) with the lease's
 * `startedAt`; a process that started AFTER the lease was taken cannot be its owner, so the lease is dead.
 *
 * Scenario: spawn a real, live, unrelated process; write a lease naming its pid with `startedAt` earlier than
 * that process's start. The tree under test must class the lease dead. PRE-fix it is classed live.
 */

import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { runSoak } from '../soak.mjs';

export default {
  id: 'rebuild-lease-reused-pid',
  title: 'a dead build lease stayed live because its pid was reused by an unrelated live process, stalling the rebuild',
  card: 'lane/lease-start-time (R372, #6213)',
  fixedBy: {
    sha: '1d7481d075',
    where: 'lane/lease-start-time',
    paths: ['scripts/lib/daemon-rebuild/lease.mjs'],
  },
  fixPresent(root) {
    try {
      return /processStartMs/.test(readFileSync(join(root, 'scripts/lib/daemon-rebuild/lease.mjs'), 'utf8'));
    } catch {
      return false;
    }
  },
  async run({ log } = {}) {
    return runSoak({
      name: 'break:rebuild-lease-reused-pid',
      rounds: 1,
      daemons: [],
      mainEvery: 0,
      fleet: false,
      log,
      async perRound(w, round, ctx, api) {
        const { buildLeaseIsLive } = await import(pathToFileURL(join(w.simCloneRoot, 'scripts/lib/daemon-rebuild/lease.mjs')).href);
        const unrelated = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
        try {
          // The lease was taken 10 minutes before this unrelated process even started: its owner is long gone.
          const nowMs = Date.now();
          const lease = {
            token: 'dead-owner', pid: unrelated.pid, host: hostname(),
            startedAt: new Date(nowMs - 600_000).toISOString(),
          };
          const live = buildLeaseIsLive(lease, { env: w.env, nowMs });
          api.say(`r${round} lease pid=${unrelated.pid} (live unrelated, started later than lease): classed live=${live}`);
          if (live) api.violation('reused-pid-lease-classed-live', 'a lease whose pid belongs to a later-started unrelated process was classed live');
        } finally {
          unrelated.kill();
        }
      },
    });
  },
  judge(report) {
    return report.violations
      .filter((v) => ['reused-pid-lease-classed-live', 'crash'].includes(v.invariant))
      .map((v) => `[${v.invariant}] ${v.detail}`);
  },
};
