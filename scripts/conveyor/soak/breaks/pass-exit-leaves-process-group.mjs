/** #5755 / PR #6020: a detached pass exits successfully with a live subprocess in its group. */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPassAsTimedJob } from '../../../../skills-src/conveyor/pass-daemon.mjs';
import { createJobStore, reapDeadGroup } from '../../../lib/daemon-jobs-runtime.mjs';
import { keepAliveScript } from '../../../lib/test-keepalive.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => {
  try { process.kill(pid, 0); return true; } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
};

export default {
  id: 'pass-exit-leaves-process-group',
  title: 'pass child exit released exclusion while a subprocess survived in its process group',
  card: '#5755 / PR #6020, red-team send-back x1b8hlo',
  fixedBy: { sha: 'lane/5755-pass-timed-job', where: 'lane/5755-pass-timed-job', paths: ['skills-src/conveyor/pass-daemon.mjs'] },
  fixPresent(root) {
    // Independently probe the refusal path instead of trusting a source marker or
    // the live scenario's verdict to decide whether that scenario should pass.
    const probe = spawnSync(process.execPath, [
      fileURLToPath(new URL('./fixtures/pass-group-completion-probe.mjs', import.meta.url)), root,
    ], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] });
    return probe.status === 0 && probe.stdout.trim() === 'quarantined';
  },
  async run({ log } = {}) {
    const root = mkdtempSync(join(tmpdir(), 'pass-exit-group-'));
    const pidFile = join(root, 'subprocess.pid');
    const store = createJobStore(join(root, 'jobs'));
    let owner;
    let pid;
    const startedMs = Date.now();
    const started = new Date(startedMs).toISOString();
    try {
      // Anchor to the soak runner so the subprocess outlives the pass, with a
      // hard lifetime bound if scenario cleanup is interrupted.
      writeFileSync(join(root, 'pass.mjs'), `
        import { spawn } from 'node:child_process';
        import { writeFileSync } from 'node:fs';
        const child = spawn(process.execPath, ['-e', ${JSON.stringify(keepAliveScript({ anchorPid: process.pid, maxLifetimeMs: 10_000 }))}], { stdio: 'ignore' });
        writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
        child.unref();
        setTimeout(() => process.exit(0), 200);
      `);
      const alerts = [];
      const result = await runPassAsTimedJob({
        passName: 'orphan-soak', repo: 'fixture/repo', entry: { script: 'pass.mjs' },
      }, {
        root, store, codeSha: 'fixture', snapshot: { materialize() {} },
        spawnFn: (...args) => { owner = spawn(...args); return owner; },
        // The sandbox forbids ps. Only identity observations are injected; launches,
        // group existence checks, SIGKILL, and death confirmation use real processes.
        host: 'fixture-host', readStart: () => started,
        probe: () => owner.exitCode === null && owner.signalCode === null ? 'alive' : 'dead',
        reapGroup: (handle, notAfterMs, options) => reapDeadGroup(handle, {
          ...options, notAfterMs, host: 'fixture-host',
          readStart: () => owner.exitCode === null && owner.signalCode === null ? started : null,
          groupStarts: () => [startedMs], bootTime: () => 0,
        }),
        policyOptions: { platform: null, tool: { timeoutMs: 5000 }, env: {}, log() {} },
        log() {}, alert: detail => alerts.push(detail),
      });
      pid = Number(readFileSync(pidFile, 'utf8'));
      const [record] = store.list().records;
      const aliveAtCompletion = alive(pid);
      const violations = [];
      if (aliveAtCompletion && (record.job.handle === null || record.job.status === 'succeeded')) {
        violations.push('child exit released exclusion with a live subprocess');
      }
      if (result.outcome === 'quarantined') {
        if (!record.job.handle || !record.job.passQuarantine || alerts.length !== 1) {
          violations.push('unconfirmed cleanup did not retain exclusion and alert');
        }
      } else if (result.code !== 0) violations.push('unexpected pass result');
      // A strict reap may report pending death immediately after SIGKILL. It must still actually kill the orphan.
      const until = Date.now() + 2000;
      while (alive(pid) && Date.now() < until) await sleep(20);
      if (alive(pid)) violations.push('subprocess escaped process-group cleanup');
      const report = { violations, result, status: record.job.status, aliveAtCompletion };
      log?.(JSON.stringify(report));
      return report;
    } finally {
      if (owner?.pid) { try { process.kill(-owner.pid, 'SIGKILL'); } catch { /* already gone */ } }
      rmSync(root, { recursive: true, force: true });
    }
  },
  judge: report => report.violations,
};
