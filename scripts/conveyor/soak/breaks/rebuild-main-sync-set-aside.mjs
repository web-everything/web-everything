/** Main-sync conflicts must not strand unpinned daemon overlays behind main. */
import { spawnSync } from 'node:child_process';
import { probeRebuildSetAside } from '../fixtures/rebuild-set-aside-probe.mjs';
export default {
  id: 'rebuild-main-sync-set-aside', title: 'main-sync conflict adopts main and restores the repaired overlay',
  card: 'daemon continuity Slice 2 REBUILD-SETASIDE',
  fixedBy: { sha: 'working-tree', where: 'working-tree', paths: [
    'scripts/lib/daemon-rebuild/plan.mjs', 'scripts/lib/daemon-rebuild/prepare.mjs',
  ] },
  fixPresent(root) {
    // Independent capability probe: exercise the planner's evidence policy. The scenario
    // below instead drives the sync worker, smoke, reset/adoption, durable state and retry.
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', String.raw`
      import * as p from './scripts/lib/daemon-rebuild/plan.mjs';
      import { createSetAsideFixture } from './scripts/conveyor/soak/fixtures/rebuild-set-aside-probe.mjs';
      const f = await createSetAsideFixture();
      try {
        process.exitCode = p.mainSyncSetAside?.(f.git, { ref: f.ref }, f.main, f.tip)?.eligible === true ? 0 : 1;
      } finally { f.cleanup(); }
    `], { cwd: root, encoding: 'utf8', timeout: 30_000, maxBuffer: 65536 });
    return result.status === 0;
  },
  async run() {
    const r = await probeRebuildSetAside();
    const ok = r.adopted && r.onMain && r.alerts === 1 && r.rebuildAlerts === 1 && r.repaired && r.reapplied && r.cleared
      && r.aside?.ref === 'lane/set-aside' && r.aside?.reason === 'main-sync-conflict'
      && JSON.stringify(r.aside.files) === JSON.stringify(['worker.mjs']);
    return { ...r, violations: ok ? [] : ['main-sync set-aside, adoption, one-alert or repair guarantee failed'] };
  },
  judge(report) { return report.violations; },
};
