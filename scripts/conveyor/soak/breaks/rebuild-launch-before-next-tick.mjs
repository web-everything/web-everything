/** @file scripts/conveyor/soak/breaks/rebuild-launch-before-next-tick.mjs — Main moves must queue before another tick. */
import { spawnSync } from 'node:child_process';
import { probeEarlyRebuild } from '../fixtures/early-rebuild-probe.mjs';

export default {
  id: 'rebuild-launch-before-next-tick',
  title: 'a main-move launches the rebuild job between daemon ticks',
  card: 'early rebuild launch',
  fixedBy: { sha: 'working-tree', where: 'working-tree', paths: ['scripts/lib/daemon-self-sync.mjs'] },
  fixPresent(root) {
    // Probe behaviour in the target tree, rather than matching source text.
    const r = spawnSync(process.execPath, ['--input-type=module', '-e',
      "import { probeEarlyRebuild } from './scripts/conveyor/soak/fixtures/early-rebuild-probe.mjs'; const r = await probeEarlyRebuild(); process.exit(r.launches.length === 1 && r.launches[0].launchedBy === 'early' ? 0 : 1);"],
    { cwd: root, encoding: 'utf8', timeout: 30_000, maxBuffer: 65536 });
    return r.status === 0;
  },
  async run({ probe = probeEarlyRebuild } = {}) {
    const result = await probe();
    return { result, violations: result.launches.length === 1 && result.launches[0].launchedBy === 'early'
      && result.launches[0].held === false && result.ticks === 1 ? [] : ['main-move did not launch before next tick'] };
  },
  judge(report) { return report.violations; },
};
