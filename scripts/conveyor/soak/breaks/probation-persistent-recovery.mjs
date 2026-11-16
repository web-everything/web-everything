/** PR #6882: persistent recovery refusals must leave a fresh daemon able to tick. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { withSelfSync } from '../../../lib/daemon-self-sync.mjs';
import { applyPendingRollback, runProbationTick } from '../../../lib/daemon-rebuild/probation.mjs';
import { acquireRead, inspectCloneLock } from '../../../lib/daemon-clone-lock.mjs';
import { cloneKeyOf } from '../../../lib/daemon-last-good.mjs';
import { alertsFilePath, writeRebuildState } from '../../../lib/daemon-rebuild/state.mjs';

export default {
  id: 'probation-persistent-recovery',
  title: 'persistent rollback failures allow fresh boots, bound alerts, and recover dead local readers',
  card: 'PR #6882 advisory prevention',
  fixedBy: { sha: 'HEAD', where: 'lane/blue-green-s2-probation-r928',
    paths: ['scripts/lib/daemon-rebuild/probation.mjs'] },
  fixPresent(root) {
    return readFileSync(join(root, 'scripts/lib/daemon-rebuild/probation.mjs'), 'utf8')
      .includes('function rollbackRestartRequired(');
  },
  async run({ log } = {}) {
    const base = mkdtempSync(join(tmpdir(), 'soak-probation-persistent-'));
    const violations = [];
    const good = 'a'.repeat(40), failed = 'b'.repeat(40);
    const at = 100_000;
    try {
      const root = join(base, 'clone');
      mkdirSync(root);
      const env = { WE_DAEMON_STATE_DIR: join(base, 'state'), WE_DAEMON_CLONE_LOCK_ROOT: join(base, 'locks') };
      mkdirSync(env.WE_DAEMON_STATE_DIR);
      const key = cloneKeyOf(root);
      const marker = join(env.WE_DAEMON_STATE_DIR, `${key}.rollback-requested.json`);
      const proven = join(env.WE_DAEMON_STATE_DIR, `${key}.proven-good.json`);
      const probation = join(env.WE_DAEMON_STATE_DIR, `${key}.probation.json`);
      const record = { from: failed, to: good, inputsKey: 'good', mainSha: good, applied: [],
        rejectInputsKey: 'failed', reason: 'no-tick-progress', at: new Date(at).toISOString() };
      const write = (file, value) => writeFileSync(file, JSON.stringify(value));
      write(marker, record);
      write(proven, { head: good, inputsKey: 'good', mainSha: good, applied: [], provenAt: new Date(at - 1000).toISOString() });
      writeRebuildState(root, { adopted: { head: failed }, forceUnverifiedTrees: [good] }, env);
      const run = () => ({ status: 0, stdout: good });
      let head = failed, ticks = 0, restarts = 0;
      for (const boot of ['stale', 'fresh']) {
        const wrapped = withSelfSync({ tickOnce() { ticks++; return 'ticked'; } }, {
          root, env, now: () => at, readHead: () => head, versions: null, background: false,
          log: { error() {} }, readState: () => ({ adopted: null }),
          importClosure: () => ({ complete: true, files: new Set(['scripts/worker.mjs']), bareDeps: false, jsonNames: new Set() }),
          diffFiles: () => ['scripts/worker.mjs'],
          acquireRead: () => ({ ok: true }), releaseRead() {},
          rebuild: async () => ({ moved: false, reason: 'still-rejected' }),
          applyPendingRollback: opts => applyPendingRollback({ ...opts, run, emit() {} }),
          onRestart() { restarts++; return 'restarted'; },
        });
        head = good;
        const result = await wrapped.tickOnce();
        if (result !== (boot === 'stale' ? 'restarted' : 'ticked')) violations.push(`${boot} boot returned ${result}`);
      }
      if (ticks !== 1 || restarts !== 1) violations.push(`persistent failure: ticks=${ticks}, restarts=${restarts}`);
      log?.(`two boots: ticks=${ticks}, restarts=${restarts}`);

      // First adoption has no provenGood; repeated watch ticks must stay bounded.
      rmSync(proven);
      write(probation, { sha: failed, prevHead: good, inputsKey: 'failed', mainSha: good, applied: [],
        adoptedAt: new Date(at).toISOString(), bootedAt: new Date(at).toISOString(), bootPid: process.pid,
        probationMs: 1000, baseline: {}, boots: 1, version: 1 });
      let events = 0;
      for (let poll = 0; poll < 4; poll++) await runProbationTick({ root, env, run: () => ({ status: 0, stdout: failed }),
        readHead: () => failed, now: () => at + 1001, log: { error() {} }, emit(event) {
          if (event.kind === 'probation-needs-you') events++;
        } });
      const alerts = readFileSync(alertsFilePath(root, env), 'utf8').trim().split('\n')
        .map(JSON.parse).filter(alert => alert.detail.reason === 'no-proven-good');
      if (alerts.length !== 1 || events !== 1) violations.push(`persistent refusal: alerts=${alerts.length}, events=${events}`);
      log?.(`four polls: refusal alerts=${alerts.length}, events=${events}`);

      // A prior daemon can die while holding a tick lease. Only confirmed local death permits reclamation.
      const deadPid = 2147483647;
      let gone = false;
      try { process.kill(deadPid, 0); } catch (error) { gone = error.code === 'ESRCH'; }
      if (!gone) throw new Error('dead-PID fixture was not verifiably dead');
      write(proven, { head: good, inputsKey: 'good', mainSha: good, applied: [], provenAt: new Date(at - 1000).toISOString() });
      writeRebuildState(root, { adopted: { head: failed } }, env);
      const lease = { owner: `${hostname()}:${deadPid}`, pid: deadPid, nowMs: at, lockRoot: env.WE_DAEMON_CLONE_LOCK_ROOT };
      if (!acquireRead(root, lease).ok) throw new Error('reader fixture acquisition failed');
      const result = await applyPendingRollback({ root, env, run, bootHead: good, now: () => at,
        lockWaitMs: 0, log: { error() {} }, emit() {} });
      if (!result.ok || inspectCloneLock(root, lease).readers.length) violations.push(`dead local reader blocked recovery: ${result.reason}`);
      log?.(`dead local reader: recovery=${result.ok === true}`);
    } catch (error) { violations.push(error.message); }
    finally { rmSync(base, { recursive: true, force: true }); }
    return { violations };
  },
  judge: report => report.violations,
};
