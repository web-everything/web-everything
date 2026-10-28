/** #5755 / PR #6020: runner shutdown must retain every timed pass monitor. */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keepAliveScript } from '../../../lib/test-keepalive.mjs';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const alive = pid => {
  try { process.kill(pid, 0); return true; } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
};

export default {
  id: 'runner-shutdown-abandons-passes',
  title: 'runner exits with live pass children and abandons discovery-dependent launches',
  card: '#5755 / PR #6020, send-back x1b8hlo item 1',
  fixedBy: { sha: 'HEAD', where: 'lane/5755-pass-timed-job', paths: ['skills-src/conveyor/runner.mjs', 'skills-src/conveyor/pass-daemon.mjs'] },
  fixPresent(checkout) {
    return readFileSync(join(checkout, 'skills-src/conveyor/runner.mjs'), 'utf8')
      .includes('await mechanicalPasses.drain?.()');
  },
  async run({ log, mode = 'once' } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'runner-shutdown-'));
    let report;
    try {
      writeFileSync(join(dir, 'hung.mjs'), keepAliveScript({ anchorPid: process.pid, maxLifetimeMs: 10_000 }));
      writeFileSync(join(dir, 'snapshot.mjs'), `
        import { writeFileSync } from 'node:fs';
        const output = process.argv.find(arg => arg.startsWith('--output=')).slice(9);
        setTimeout(() => writeFileSync(output, '[]'), 50);
      `);
      const child = spawnSync(process.execPath, [
        fileURLToPath(new URL('./fixtures/runner-shutdown-probe.mjs', import.meta.url)), root, dir, mode,
      ], { encoding: 'utf8', timeout: 8000, killSignal: 'SIGKILL' });
      if (!existsSync(join(dir, 'report.json'))) {
        throw new Error(`runner probe exited without a report (status=${child.status}, signal=${child.signal}): ${child.stderr}`);
      }
      report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'));
      await new Promise(resolve => setTimeout(resolve, 240));
      const survivors = report.pids.filter(alive);
      const violations = [];
      const daemon = mode.startsWith('daemon-');
      if (child.status !== (mode.endsWith('error') ? 1 : 0)) violations.push(`unexpected runner exit: ${child.status}: ${child.stderr}`);
      if (!report.released && mode !== 'daemon-sleep-error') violations.push('runner did not release its lease');
      if (report.jobs.some(job => !job.result)) violations.push('runner exited before recording pass completion');
      if (!daemon && !report.launched.includes('parked-pr-progress-watch')) violations.push('snapshot-dependent pass was never launched');
      for (const passName of daemon ? ['infra-blocked'] : ['infra-blocked', 'parked-pr-progress-watch']) {
        if (!report.results.some(row => row.passName === passName && row.result.outcome === 'timeout')) {
          violations.push(`${passName} did not record its timed-job timeout`);
        }
      }
      if (survivors.length) violations.push('pass children survived runner exit beyond their deadlines');
      if (mode.startsWith('SIG') && report.ticks !== report.ticksAtSignal) violations.push('runner admitted more ticks during signal shutdown');
      if (['max-ticks', 'error', 'restart'].includes(mode) && !report.overlapped) violations.push('outstanding pass blocked the next tick');
      const result = { mode, violations, survivors, ...report };
      log?.(JSON.stringify(result));
      return result;
    } finally {
      const pids = existsSync(join(dir, 'pids.json')) ? JSON.parse(readFileSync(join(dir, 'pids.json'), 'utf8')) : [];
      for (const pid of pids) {
        try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
      }
      for (const file of report?.snapshotDirs ?? []) rmSync(dirname(file), { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  },
  judge: report => report.violations,
};
