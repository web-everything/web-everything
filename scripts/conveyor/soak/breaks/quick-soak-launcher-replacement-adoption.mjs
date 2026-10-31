/** PR #6084: a launcher waiting for readers must not recover the next adoption as a dead worker. */
import { isDeepStrictEqual } from 'node:util';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { acquireRead, inspectCloneLock, releaseRead } from '../../../lib/daemon-clone-lock.mjs';
import { cloneKey } from '../../../lib/daemon-overlays.mjs';
import { createJobStore, enqueueJob, selfHandle } from '../../../lib/daemon-jobs-runtime.mjs';
import { markClaimed, markFailed, markLaunching } from '../../../lib/daemon-jobs.mjs';
import { launchPinnedSoak, QUICK_SOAK_JOB_KIND } from '../../../lib/daemon-rebuild/quick-soak-job.mjs';
import { readRebuildState, writeRebuildState } from '../../../lib/daemon-rebuild/state.mjs';
import { daemonJobsDir } from '../../../operations/run-store.mjs';

export default {
  id: 'quick-soak-launcher-replacement-adoption',
  title: 'A stale quick-soak launcher preserves a replacement adoption after the write barrier',
  card: 'PR #6084',
  // Undo the shared fence before the original launcher fence when replaying the pre-fix tree.
  fixedBy: { sha: '1195bffdd7,35900b9739', where: 'lane/daemon-rebuild-quick-mode',
    paths: ['scripts/lib/daemon-rebuild/quick-soak-job.mjs'] },
  fixPresent(root) {
    return readFileSync(join(root, 'scripts/lib/daemon-rebuild/quick-soak-job.mjs'), 'utf8')
      .includes('if (!assertMarkerIdentity(state, { ...marker, head:');
  },
  async run() {
    const root = mkdtempSync(join(tmpdir(), 'quick-launcher-race-'));
    const env = { WE_DAEMON_STATE_DIR: join(root, 'state'), WE_DAEMON_JOBS_ROOT: join(root, 'jobs'),
      WE_DAEMON_CLONE_LOCK_ROOT: join(root, 'locks'), WE_DAEMON_OVERLAY_DIR: join(root, 'overlays') };
    const violations = [];
    const reader = { owner: 'replacement-barrier-reader', lockRoot: env.WE_DAEMON_CLONE_LOCK_ROOT };
    let launch;
    try {
      const sha = 'a'.repeat(40);
      const store = createJobStore(daemonJobsDir(`quick-soak-${cloneKey(root)}`, env));
      mkdirSync(store.dir, { recursive: true });
      const old = enqueueJob({ store, kindDef: QUICK_SOAK_JOB_KIND, codeSha: sha });
      // Its worker has already stopped; the launcher is now performing final recovery.
      store.update(old.id, record => markFailed(record, { at: new Date().toISOString(), reason: 'worker exited' }));
      const marker = { quick: true, sha, head: sha, token: 'old-adoption', prevHead: 'b'.repeat(40),
        soakAttempts: 3, adoptedAt: new Date().toISOString(), deadline: Date.now() + 60_000, jobId: old.id };
      writeRebuildState(root, { unverified: marker, adopted: { head: sha, unverified: true } }, env);
      if (!acquireRead(root, reader).ok) throw new Error('could not hold the read barrier');
      const resets = [];
      launch = launchPinnedSoak({ root, env, token: marker.token, jobId: old.id, log: { error() {} },
        run: args => {
          if (args[0] === 'reset') resets.push(args);
          return { status: 0, stdout: args[0] === 'rev-parse' ? sha : '' };
        } });
      const until = Date.now() + 5000;
      while (!inspectCloneLock(root, { lockRoot: reader.lockRoot }).writerLive) {
        if (Date.now() > until) throw new Error('launcher never reached the write barrier');
        await pause(10);
      }
      const next = enqueueJob({ store, kindDef: QUICK_SOAK_JOB_KIND, codeSha: sha });
      const at = new Date().toISOString();
      store.update(next.id, record => markLaunching(record, { at, launcherPid: process.pid, cwd: root, snapshotKeys: [] }));
      store.update(next.id, record => markClaimed(record, { at,
        ...selfHandle({ readStart: () => 'Thu Jan  1 00:00:00 1970' }) }));
      const nextJob = store.read(next.id);
      const replacement = { ...marker, token: 'new-adoption', jobId: next.id, pid: process.pid };
      writeRebuildState(root, { unverified: replacement, adopted: { head: sha, unverified: true } }, env);
      const expected = readRebuildState(root, env);
      releaseRead(root, reader);
      await launch;
      if (!isDeepStrictEqual(readRebuildState(root, env), expected)) violations.push('replacement adoption changed');
      if (!isDeepStrictEqual(store.read(next.id), nextJob)) violations.push('replacement live job retired');
      if (resets.length) violations.push('replacement HEAD reset');
      return { violations };
    } finally {
      releaseRead(root, reader);
      if (launch) await launch;
      rmSync(root, { recursive: true, force: true });
    }
  },
  judge(report) { return report.violations; },
};
