/** Timed holds and overdue registrations must restart the detached rebuild path. */
import { spawnSync } from 'node:child_process';
import { probeRebuildRecovery } from '../fixtures/rebuild-recovery-probe.mjs';
export default {
  id: 'rebuild-held-recovery', title: 'held clones retry without unrelated overlay changes', card: 'timed rebuild recovery',
  fixedBy: { sha: 'working-tree', where: 'working-tree', paths: ['scripts/lib/daemon-rebuild/rebuild-job.mjs', 'scripts/lib/daemon-rebuild/recovery.mjs'] },
  fixPresent(root) {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e',
      "import { probeRebuildRecovery } from './scripts/conveyor/soak/fixtures/rebuild-recovery-probe.mjs'; const r = await probeRebuildRecovery({ timeout: true }); process.exit(r.due === 'rebuild-job-started' && r.jobs === 1 ? 0 : 1);"],
    { cwd: root, encoding: 'utf8', timeout: 30_000, maxBuffer: 65536 });
    return r.status === 0;
  },
  async run() {
    const results = await Promise.all([probeRebuildRecovery({ timeout: true }), probeRebuildRecovery({ timeout: true, legacy: true }), probeRebuildRecovery()]);
    return { results, violations: results.every(r => r.due === 'rebuild-job-started' && r.again === 'rebuild-job-running' && r.jobs === 1) ? [] : ['recovery failed or queued duplicate jobs'] };
  },
  judge(report) { return report.violations; },
};
