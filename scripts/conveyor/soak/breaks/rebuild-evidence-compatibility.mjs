/** Writer output and legacy audit metadata must not wedge rebuild admission. */
import { spawnSync } from 'node:child_process';
import { probeRebuildEvidence } from '../fixtures/rebuild-evidence-probe.mjs';

export default {
  id: 'rebuild-evidence-compatibility',
  title: 'legacy evidence permits new-plan rebuilds during an old timeout hold',
  card: 'PR 7196 persisted evidence compatibility',
  fixedBy: { sha: 'working-tree', where: 'working-tree', paths: [
    'scripts/lib/daemon-rebuild/rebuild-job.mjs', 'scripts/lib/daemon-rebuild/evidence-readers.mjs',
    'scripts/lib/daemon-rebuild/recovery.mjs', 'scripts/lib/daemon-rebuild/prepare.mjs', 'scripts/lib/daemon-rebuild/smoke.mjs',
  ] },
  fixPresent(root) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
      "import { probeRebuildEvidence } from './scripts/conveyor/soak/fixtures/rebuild-evidence-probe.mjs'; const r = await probeRebuildEvidence(); process.exit(r.changed === 'rebuild-job-started' && r.consumedReason === 'no-result' ? 0 : 1);"],
    { cwd: root, encoding: 'utf8', timeout: 30_000, maxBuffer: 65536 });
    return result.status === 0;
  },
  async run() {
    try {
      const result = await probeRebuildEvidence();
      return { result, violations: result.before === 'smoke-env-timeout-backoff' && result.consumedReason === 'no-result'
        && result.changed === 'rebuild-job-started' && result.again === 'rebuild-job-running'
        && result.jobs === 2 && result.preserved ? [] : ['persisted evidence blocked admission or duplicated a rebuild'] };
    } catch (error) { return { violations: [String(error.message)] }; }
  },
  judge(report) { return report.violations; },
};
