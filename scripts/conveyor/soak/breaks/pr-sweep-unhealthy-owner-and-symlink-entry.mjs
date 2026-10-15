/**
 * @file pr-sweep-unhealthy-owner-and-symlink-entry.mjs
 * @description PR #5323 red-team replay: unhealthy sessions mask stalls; symlink launches skip entry points.
 */
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { runPrSweep } from '../../pr-sweep.mjs';

const CONVEYOR = fileURLToPath(new URL('../../', import.meta.url));
export default {
  id: 'pr-sweep-unhealthy-owner-and-symlink-entry',
  title: 'unhealthy sessions must not mask stalled PR alerts, and symlink launches must run both sweep entry points',
  card: 'PR #5323 post-accept red-team findings',
  fixedBy: { sha: 'PR #5323 repair', where: 'lane/pr-sweep-health-job', paths: [
    'scripts/conveyor/pr-sweep-core.mjs', 'scripts/conveyor/pr-sweep-job.mjs', 'scripts/conveyor/pr-sweep.mjs', 'scripts/conveyor/health-watch.mjs',
  ] },
  fixPresent(root) {
    return ['pr-sweep-core.mjs', 'pr-sweep-job.mjs', 'pr-sweep.mjs', 'health-watch.mjs'].every((name) => {
      const source = readFileSync(join(root, 'scripts/conveyor', name), 'utf8');
      return name === 'pr-sweep-core.mjs' ? source.includes('a.hung !== true') && source.includes('a.pidAlive !== false')
        : source.includes('realpathSync(argv1)');
    });
  },
  async run({ log } = {}) {
    const violations = []; const owners = []; const entries = [];
    const now = Date.parse('2026-10-14T16:00:00Z');
    const repo = 'web-everything/web-everything'; const key = `${repo}#12`;
    const pr = { repo, number: 12, title: 'idle PR', updatedAt: new Date(now - 120 * 60000).toISOString(), headRefOid: 'abc' };
    const value = { idleMinutes: 45, stuckAfterMinutes: 90, stuckAlertMinutes: 90, dispatchDiagnosis: false, repos: [repo] };
    for (const health of [{ hung: true }, { pidAlive: false }, { hung: true, pidAlive: false }]) {
      let previous = {}; const samples = []; let alertCount = 0;
      for (const minutes of [0, 30, 60, 90, 120, 240]) {
        const report = await runPrSweep({ now: now + minutes * 60000, dryRun: true, config: {},
          settings: { value, sources: {} }, readPrevious: () => previous, readPrs: () => [pr],
          readQueue: () => ({ ready: [], rulingNeeded: [] }),
          readSignals: () => ({ [key]: { sessions: [{ name: 'fix-12', state: 'working', ...health }] } }) });
        previous = report.nextState; alertCount += report.alerts.length;
        samples.push({ minutes, state: report.idle[0].state, episodes: Object.keys(previous.episodes).length, alerts: report.alerts.length });
      }
      owners.push({ health, samples, alertCount });
      if (alertCount !== 1 || samples.some((s) => s.state !== 'none' || s.episodes !== 1)) {
        violations.push({ invariant: 'unhealthy-owner-masks-stall', detail: JSON.stringify(owners.at(-1)) });
      }
    }
    const root = mkdtempSync(join(tmpdir(), 'soak-pr-sweep-entry-'));
    try {
      const alias = join(root, 'conveyor-link'); symlinkSync(CONVEYOR, alias, 'dir');
      const env = { ...process.env, NODE_NO_WARNINGS: '1' };
      for (const key of ['DAEMON_JOB_ID', 'DAEMON_JOB_ATTEMPT', 'OPERATION_RUNS_DIR']) delete env[key];
      const invoke = (path) => spawnSync(process.execPath, [path, 'invalid-command'], { env, encoding: 'utf8', timeout: 15000 });
      for (const [script, expected] of [['pr-sweep-job.mjs', 1], ['pr-sweep.mjs', 2], ['health-watch.mjs', 1]]) {
        const path = join(alias, script); const direct = invoke(realpathSync(path)); const linked = invoke(path);
        entries.push({ script, direct: direct.status, linked: linked.status });
        if (direct.error || linked.error || direct.status !== expected || linked.status !== expected || direct.stdout !== linked.stdout || direct.stderr !== linked.stderr) {
          violations.push({ invariant: 'symlink-entry-skipped', detail: JSON.stringify(entries.at(-1)) });
        }
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
    const report = { violations, owners, entries }; log?.(JSON.stringify(report)); return report;
  },
  judge(report) { return report.violations.map((v) => `[${v.invariant}] ${v.detail}`); },
};
