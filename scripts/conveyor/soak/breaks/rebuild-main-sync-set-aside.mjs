/** Main-sync conflicts must not strand unpinned daemon overlays behind main. */
import { spawnSync } from 'node:child_process';
import { probeRebuildSetAside, probeOmissionEvidence } from '../fixtures/rebuild-set-aside-probe.mjs';
export default {
  id: 'rebuild-main-sync-set-aside', title: 'main-sync conflict adopts main and restores the repaired overlay',
  card: 'daemon continuity Slice 2 REBUILD-SETASIDE',
  fixedBy: { sha: 'working-tree', where: 'working-tree', paths: [
    'scripts/lib/daemon-rebuild/plan.mjs', 'scripts/lib/daemon-rebuild/prepare.mjs',
    'scripts/lib/daemon-rebuild/smoke.mjs', 'scripts/lib/daemon-rebuild/adopt.mjs',
  ] },
  fixPresent(root) {
    // Independent capability probe: exercise the planner's evidence policy. The scenario
    // below instead drives the sync worker, smoke, reset/adoption, durable state and retry.
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', String.raw`
      import * as p from './scripts/lib/daemon-rebuild/plan.mjs';
      import { createSetAsideFixture, probeOmissionEvidence } from './scripts/conveyor/soak/fixtures/rebuild-set-aside-probe.mjs';
      const f = await createSetAsideFixture();
      try {
        const mainOnly = await probeOmissionEvidence({ mainOnly: true });
        const deferred = await probeOmissionEvidence({ readyOnly: true });
        const containing = await probeOmissionEvidence({ containing: 'descendant', stackMode: 'independent' });
        process.exitCode = p.mainSyncSetAside?.(f.git, { ref: f.ref }, f.main, f.tip)?.eligible === true
          && mainOnly.adopted && deferred.aside && deferred.held
          && containing.childHeld && containing.applied === 0 && !containing.carriesRepair ? 0 : 1;
      } finally { f.cleanup(); }
    `], { cwd: root, encoding: 'utf8', timeout: 30_000, maxBuffer: 65536 });
    return result.status === 0;
  },
  async run() {
    const r = await probeRebuildSetAside();
    const mainOnly = await probeOmissionEvidence({ mainOnly: true, cached: true });
    const deferred = await probeOmissionEvidence({ readyOnly: true });
    const containing = await probeOmissionEvidence({ containing: 'descendant', stackMode: 'independent' });
    const audited = await probeOmissionEvidence({ containing: 'descendant', stackMode: 'independent', auditedBase: true });
    const ok = r.adopted && r.onMain && r.alerts === 1 && r.rebuildAlerts === 1 && r.repaired && r.reapplied && r.cleared
      && r.aside?.ref === 'lane/set-aside' && r.aside?.reason === 'main-sync-conflict'
      && JSON.stringify(r.aside.files) === JSON.stringify(['worker.mjs'])
      && mainOnly.adopted && mainOnly.onTarget && mainOnly.checks.every(c => c.changedFiles === null && !c.reuseCode)
      && deferred.adopted && deferred.aside && deferred.beforeAdopt === null && deferred.held && deferred.applied === 0 && deferred.audits > 0
      && containing.childHeld && containing.applied === 0 && !containing.carriesRepair
      && !audited.childHeld && audited.repairAdopted && audited.carriesRepair;
    return { ...r, mainOnly, deferred, containing, audited,
      violations: ok ? [] : ['main-sync set-aside, full smoke, deferred history or containment audit guarantee failed'] };
  },
  judge(report) { return report.violations; },
};
