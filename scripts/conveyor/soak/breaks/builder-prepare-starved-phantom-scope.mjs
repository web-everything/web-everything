/**
 * @file breaks/builder-prepare-starved-phantom-scope.mjs — builder-starved (2026-10-07). The build-dispatch
 * daemon launched NOTHING from 03:45Z to 10:51Z with ~400 queued and both item-prepare slots free.
 *
 * Mechanism: the daemon's own tick-core call planned ~24 prepare-SCOPE spawns (the daemon never launches that
 * kind). Their guards read as "26 preparing", and they were charged to the queue-time budget BEFORE the item
 * prepares, so both item prepares were held `queue-cap`. Meanwhile two failure-held cards sat at the head of the
 * pinned tier and filled half of the 4-slot prepare-ahead window. Nothing was prepared, so nothing became
 * build-ready.
 *
 * Fix: the daemon passes `launchKinds: ['prepare-item']` (`planConfigFrom`), so tick-core never plans a kind it
 * does not launch, and the prepare-ahead window skips cards the caller holds (`bookkeeping.prepareHeldNums`).
 *
 * SCENARIO: the REAL `planTick` with the daemon's REAL config: 6 unscoped cards, a pinned head of two held cards
 * then four needs-prepare cards, and a queue budget with room for two prepare spawns.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { planTick } from '../../tick-core.mjs';
import { planConfigFrom } from '../../../../skills-src/conveyor/build-dispatch-daemon.mjs';
import { BUILD_DISPATCH_POLICY } from '../../build-dispatch-policy.mjs';

export default {
  id: 'builder-prepare-starved-phantom-scope',
  title: 'phantom prepare-scope spawns spent the queue budget and held cards filled the prepare window, so the builder prepared and built nothing for 7h',
  card: 'lane/builder-starved (2026-10-07 builder starvation)',
  fixedBy: { sha: 'ef6015d53', where: 'lane/builder-starved', paths: ['scripts/conveyor/tick-core.mjs', 'scripts/conveyor/build-dispatch-policy.mjs', 'skills-src/conveyor/build-dispatch-daemon.mjs'] },
  fixPresent(root) {
    const p = join(root, 'scripts/conveyor/tick-core.mjs');
    return existsSync(p) && /config\.launchKinds/.test(readFileSync(p, 'utf8'));
  },
  async run({ log } = {}) {
    const queue = [{ num: '1', tier: 'pinned' }, { num: '2', tier: 'pinned' }, { num: '3' }, { num: '4' }, { num: '5' }, { num: '6' }];
    const out = planTick({
      state: { queue, lanes: [], prs: [], unshaped: ['20', '21', '22', '23', '24', '25'].map((num) => ({ num })) },
      plan: { launch: [], held: queue.map((q) => ({ num: q.num, reason: 'needs-prepare' })) },
      freeLanes: Array.from({ length: 20 }, (_, i) => i + 1),
      bookkeeping: { tick: 1, prepareHeldNums: ['1', '2'] },
      config: { maxConcurrentLanes: 1_000_000, ...planConfigFrom(BUILD_DISPATCH_POLICY) },
      queueAdmission: { maxWaitMinutes: 2.5, slots: 1, backlogMinutes: 0, dispatchMinutes: { prepare: 1 } },
    });
    const items = (out.decisions.spawnPrepareItems || []).map((s) => s.num);
    log?.(`items=${items.join(',')} scope=${(out.decisions.spawnPrepareScope || []).length} preparing=${out.decisions.counts?.preparing}`);
    const violations = [];
    if (items.length === 0) violations.push({ invariant: 'no-item-prepare', detail: `no item prepare planned (scope spawns: ${(out.decisions.spawnPrepareScope || []).length}; notes: ${(out.decisions.notes || []).map((n) => n.kind).join(',')})` });
    if ((out.decisions.spawnPrepareScope || []).length) violations.push({ invariant: 'phantom-scope-spawn', detail: `${out.decisions.spawnPrepareScope.length} prepare-scope spawns planned for a caller that never launches them` });
    if (items.some((n) => n === '1' || n === '2')) violations.push({ invariant: 'held-card-planned', detail: `a caller-held card was planned: ${items.join(',')}` });
    return { violations, items };
  },
  judge(report) {
    return report.violations.map((v) => `[${v.invariant}] ${v.detail}`);
  },
};
