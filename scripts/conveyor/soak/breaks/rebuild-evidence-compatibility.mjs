/** Writer output and legacy audit metadata must not wedge rebuild admission. */
import { spawnSync } from 'node:child_process';
import { probeRebuildEvidence, probeStalePinnedReady, probeTickCompatibility, probeNullableRollback } from '../fixtures/rebuild-evidence-probe.mjs';

export default {
  id: 'rebuild-evidence-compatibility',
  title: 'legacy and stale ready evidence permit fresh rebuilds at tick start',
  card: 'PR 7196 persisted evidence compatibility',
  fixedBy: { sha: 'working-tree', where: 'working-tree', paths: [
    'scripts/lib/daemon-rebuild/rebuild-job.mjs', 'scripts/lib/daemon-rebuild/evidence-readers.mjs',
    'scripts/lib/daemon-rebuild/recovery.mjs', 'scripts/lib/daemon-rebuild/prepare.mjs', 'scripts/lib/daemon-rebuild/smoke.mjs',
    'scripts/lib/daemon-rebuild/state.mjs', 'scripts/lib/daemon-rebuild/evidence-context.mjs', 'scripts/lib/daemon-rebuild/lease.mjs',
  ] },
  fixPresent(root) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
      "import { probeRebuildEvidence, probeStalePinnedReady, probeTickCompatibility, probeNullableRollback } from './scripts/conveyor/soak/fixtures/rebuild-evidence-probe.mjs'; const r = await probeRebuildEvidence(); const s = await probeStalePinnedReady(); const a = await probeStalePinnedReady({ auditedOnly: true }); const t = await probeTickCompatibility(); const w = await probeNullableRollback(); process.exit(w.head === w.good && !w.errors.length && w.watch === null && !t.violations.length && r.changed === 'rebuild-job-started' && r.consumedReason === 'no-result' && s.adopted && s.discarded && s.readyCleared && s.freshHead && s.smokes === 1 && a.adopted && !a.discarded && a.readyCleared && !a.freshHead && a.smokes === 0 && a.heldTipExcluded ? 0 : 1);"],
    { cwd: root, encoding: 'utf8', timeout: 30_000, maxBuffer: 65536 });
    return result.status === 0;
  },
  async run() {
    try {
      const result = await probeRebuildEvidence();
      const stale = await probeStalePinnedReady();
      const audited = await probeStalePinnedReady({ auditedOnly: true });
      const tick = await probeTickCompatibility();
      const rollback = await probeNullableRollback();
      return { result, stale, audited, tick, rollback, violations: [...tick.violations,
        ...(rollback.head === rollback.good && rollback.resets.length === 1 && rollback.errors.length === 0
          && rollback.snapshots[0]?.inputsKey === null && rollback.snapshots[0]?.mainSha === null
          && rollback.state?.inProgress === null && rollback.state?.adopted?.head === rollback.good
          && rollback.watch === null && rollback.events.some(event => event.kind === 'force-adopt-rolled-back')
          ? [] : ['health-watch rollback with null lastGood plan keys left unreadable state or the unhealthy build']),
        ...(audited.adopted && !audited.discarded && audited.readyCleared && !audited.freshHead && audited.smokes === 0 && audited.heldTipExcluded
          ? [] : ['audited applied pin was discarded or the unaudited held tip was adopted']),
        ...(stale.adopted && stale.discarded && stale.readyCleared && stale.freshHead && stale.smokes === 1
        && result.before === 'smoke-env-timeout-backoff' && result.consumedReason === 'no-result'
        && result.changed === 'rebuild-job-started' && result.again === 'rebuild-job-running'
        && result.jobs === 2 && result.preserved ? [] : ['persisted evidence blocked admission or duplicated a rebuild'])] };
    } catch (error) { return { violations: [String(error.message)] }; }
  },
  judge(report) { return report.violations; },
};
