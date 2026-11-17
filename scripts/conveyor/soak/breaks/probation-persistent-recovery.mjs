/** PR #6882: persistent recovery refusals skip ticks without a restart loop. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { withSelfSync } from '../../../lib/daemon-self-sync.mjs';
import { applyPendingRollback, checkProbationAtTick } from '../../../lib/daemon-rebuild/probation.mjs';
import { acquireRead, inspectCloneLock } from '../../../lib/daemon-clone-lock.mjs';
import { cloneKeyOf } from '../../../lib/daemon-last-good.mjs';
import { alertsFilePath, readRebuildState, writeRebuildState } from '../../../lib/daemon-rebuild/state.mjs';

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
      const record = { adoptionId: '11111111-1111-4111-8111-111111111111', from: failed, to: good, inputsKey: 'good', mainSha: good, applied: [],
        rejectInputsKey: 'failed', reason: 'no-tick-progress', at: new Date(at).toISOString() };
      const write = (file, value) => writeFileSync(file, JSON.stringify(value));
      write(marker, record);
      write(proven, { head: good, inputsKey: 'good', mainSha: good, applied: [], provenAt: new Date(at - 1000).toISOString() });
      writeRebuildState(root, { adopted: { head: failed }, forceUnverifiedTrees: [good] }, env);
      let head = failed, ticks = 0, restarts = 0, resets = 0;
      // Model a clean checkout and its HEAD transitions without writing .git.
      // A catch-all success would invent MERGE_HEAD and dirty status output,
      // preventing the real finalizer from ever reaching the recovery reset.
      const run = args => {
        if (args[0] === 'rev-parse') {
          const rev = args.at(-1);
          if (rev === 'HEAD') return { status: 0, stdout: head };
          if (rev === `${good}^{tree}`) return { status: 0, stdout: good };
          if (rev === 'MERGE_HEAD') return { status: 1, stdout: '' };
        }
        if (args[0] === 'reset' && args[1] === '--hard' && args[2] === good && args.length === 3) {
          if (readRebuildState(root, env).rejected?.inputsKey !== record.rejectInputsKey) {
            violations.push('reset preceded durable failed-input rejection');
          }
          resets++;
          head = good;
          return { status: 0, stdout: '' };
        }
        if (['ls-files', 'status', 'cat-file', 'rev-list'].includes(args[0])) return { status: 0, stdout: '' };
        throw new Error(`Unexpected Git operation: ${args.join(' ')}`);
      };
      for (const boot of ['stale', 'fresh', 'failed-head']) {
        if (boot === 'failed-head') {
          head = failed;
          write(probation, { adoptionId: record.adoptionId, sha: failed, prevHead: good, inputsKey: 'failed', mainSha: good, applied: [],
            adoptedAt: new Date(at - 1001).toISOString(), bootedAt: new Date(at - 1001).toISOString(), bootPid: process.pid,
            probationMs: 1000, baseline: {}, boots: 1, version: 1 });
        }
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
        if (boot !== 'failed-head') head = good;
        for (let poll = 0; poll < 2; poll++) {
          const result = await wrapped.tickOnce();
          const expected = boot === 'stale' ? result === 'restarted'
            : result?.skipped === true && result.reason === 'proven-good-unverified';
          if (!expected) violations.push(`${boot} boot poll ${poll} returned ${JSON.stringify(result)}`);
        }
      }
      if (ticks !== 0 || restarts !== 1) violations.push(`persistent failure: ticks=${ticks}, restarts=${restarts}`);
      if (resets !== 0) violations.push('refused recovery reset the checkout');
      log?.(`three boots, two polls each: ticks=${ticks}, restarts=${restarts}`);

      // First adoption has no provenGood; repeated tick checks must stay bounded.
      rmSync(proven);
      rmSync(marker);
      write(probation, { adoptionId: record.adoptionId, sha: failed, prevHead: good, inputsKey: 'failed', mainSha: good, applied: [],
        adoptedAt: new Date(at).toISOString(), bootedAt: new Date(at).toISOString(), bootPid: process.pid,
        probationMs: 1000, baseline: {}, boots: 1, version: 1 });
      let events = 0;
      for (let poll = 0; poll < 4; poll++) await checkProbationAtTick({ root, env, run,
        bootSha: failed, bootAt: at, now: () => at + 1001, log: { error() {} }, emit(event) {
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
      write(marker, record);
      const lease = { owner: `${hostname()}:${deadPid}`, pid: deadPid, nowMs: at, lockRoot: env.WE_DAEMON_CLONE_LOCK_ROOT };
      if (!acquireRead(root, lease).ok) throw new Error('reader fixture acquisition failed');
      const result = await applyPendingRollback({ root, env, run, bootHead: good, now: () => at,
        lockWaitMs: 0, log: { error() {} }, emit() {} });
      if (!result.ok || inspectCloneLock(root, lease).readers.length) violations.push(`dead local reader blocked recovery: ${result.reason}`);
      if (resets !== 1 || head !== good || result.head !== good) violations.push('dead-reader recovery did not reset exactly once to proven good');
      if (existsSync(marker) || existsSync(probation)) violations.push('successful recovery retained pending evidence');
      const recovered = readRebuildState(root, env);
      if (recovered.adopted?.head !== good || recovered.rejected?.inputsKey !== record.rejectInputsKey) {
        violations.push('successful recovery lost adopted head or failed-input rejection');
      }
      log?.(`dead local reader: recovery=${result.ok === true}`);
    } catch (error) { violations.push(error.message); }
    finally { rmSync(base, { recursive: true, force: true }); }
    return { violations };
  },
  judge: report => report.violations,
};
