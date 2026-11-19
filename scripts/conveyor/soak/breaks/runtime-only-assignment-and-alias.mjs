/** PR #7090: runtime-only admission must precede assignment and retain durable card aliases. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { orderQueueDetailed, readBuildPrioritySettings } from '../../../lib/build-queue.mjs';
import { dispatchPlan, projectBuildQueueRow } from '../../../readiness/dispatch-plan.mjs';
import { planTick } from '../../tick-core.mjs';
import { assertRuntimeAdmitted, withRuntimeAdmission, withRuntimeAdmissionTick, setRuntimeAdmissionCards } from '../../../lib/runtime-admission.mjs';

const now = Date.parse('2026-11-18T13:14:00Z');
const freeLanes = [20, 21];
const nums = rows => rows.map(row => String(row.num));
const card = (num, extra = {}) => ({ num, status: 'open', kind: 'story', size: 1,
  buildQueued: true, scope: ['we:scripts/shared.mjs'], preparedDate: '2026-11-18', ...extra });
function settings(ids) {
  return readBuildPrioritySettings({ env: {}, read: () => ({}), now,
    readRuntime: () => JSON.stringify({ ids, mode: 'only', setBy: 'operator',
      at: '2026-11-18T13:00:00Z', ttlHours: 48 }) });
}
function ordered(cards, buildPriority) {
  const ranked = orderQueueDetailed(cards, undefined, now, { priority: { mode: 'off' }, buildPriority: buildPriority.ids });
  return { ranked, queue: ranked.map(row => ({ ...projectBuildQueueRow({ num: row.item.num }, row.item),
    ready: true, buildQueued: row.buildQueued })) };
}
function tick(queue, buildPriority, tickNumber = 0) {
  const plan = dispatchPlan({ queue, buildPriority, leases: [], freeLanes,
    preparePolicy: { requirePreparedDate: true } });
  const out = planTick({ state: { queue, lanes: [], prs: [] }, plan, freeLanes, now,
    bookkeeping: { tick: tickNumber }, config: { buildPriority, prepareAheadWindow: 2 } });
  return { plan, out };
}

export default {
  id: 'runtime-only-assignment-and-alias',
  title: 'runtime-only filtering starves a listed scope rival and loses a numbered card’s bornAs alias',
  card: 'PR #7090 / x1b8hlo send-back items 1 and 2',
  fixedBy: { sha: '1227f286e5', where: 'lane/runtime-only-wiring', paths: [
    'scripts/readiness/dispatch-plan.mjs', 'scripts/lib/build-queue.mjs',
    'scripts/conveyor/tick-core.mjs', 'scripts/readiness/conveyor-state.mjs',
    'skills-src/conveyor/build-dispatch-daemon.mjs',
    'scripts/lib/runtime-admission.mjs',
  ] },
  fixPresent(root) {
    const planner = readFileSync(join(root, 'scripts/readiness/dispatch-plan.mjs'), 'utf8');
    const admission = readFileSync(join(root, 'scripts/lib/runtime-admission.mjs'), 'utf8');
    const identity = readFileSync(join(root, 'scripts/lib/build-queue.mjs'), 'utf8');
    const daemon = readFileSync(join(root, 'skills-src/conveyor/build-dispatch-daemon.mjs'), 'utf8');
    return planner.includes('filterRuntimeCandidates(items, buildPriority)')
      && planner.includes("blocked('runtime-only', !runtimeCandidates.has(item)")
      && admission.includes('export function assertRuntimeAdmitted(')
      && admission.includes('export function withRuntimeAdmission(')
      && admission.includes('if (runtimeRefused.length) return')
      && daemon.includes('withRuntimeAdmission({ ...pick, groupMembers }')
      && /card\?\.bornAs/.test(identity);
  },
  async run({ log } = {}) {
    const violations = [];
    const priority = settings(['7000', '8001']);
    const { queue, ranked } = ordered([
      card('7000', { kind: 'epic' }), card('7001', { parent: '7000' }), card('8001'),
    ], priority);
    const childIndex = ranked.findIndex(row => row.item.num === '7001');
    const rivalIndex = ranked.findIndex(row => row.item.num === '8001');
    if (childIndex < 0 || rivalIndex < 0 || childIndex >= rivalIndex
        || ranked[childIndex].buildPriorityVia !== '7000') {
      violations.push('fixture must rank the unlisted child before its listed scope rival via epic priority');
    }
    // No completed work or changed inputs between observations: the old planner stays starved on both ticks.
    const snapshots = [0, 1].map(n => tick(queue, priority, n));
    snapshots.forEach(({ plan, out }, n) => {
      const builds = nums(out.decisions.spawnBuilds);
      log?.(`assignment tick=${n} launch=${JSON.stringify(plan.launch)} builds=${builds.join(',')}`);
      if (JSON.stringify(builds) !== '["8001"]' || plan.launch.length !== 1 || plan.launch[0].lane !== 20) {
        violations.push(`assignment tick ${n}: listed #8001 must launch on lane 20; got ${JSON.stringify(plan)}`);
      }
    });

    const aliasPriority = settings(['xabcdef0']);
    const alias = card('8001', { id: '8001-renamed', bornAs: 'xabcdef0' });
    const aliasOrder = ordered([alias], aliasPriority);
    if (aliasOrder.ranked[0]?.buildPriorityIndex !== 0) violations.push('fixture must rank bornAs at priority index 0');
    const build = tick(aliasOrder.queue, aliasPriority);
    const prepare = tick(ordered([{ ...alias, preparedDate: null }], aliasPriority).queue, aliasPriority);
    const aliasBuilds = nums(build.out.decisions.spawnBuilds);
    const aliasPrepares = nums(prepare.out.decisions.spawnPrepareItems);
    log?.(`alias rank=${aliasOrder.ranked[0]?.buildPriorityIndex} builds=${aliasBuilds.join(',')} prepares=${aliasPrepares.join(',')}`);
    if (JSON.stringify(aliasBuilds) !== '["8001"]') violations.push(`bornAs build withheld: ${JSON.stringify(build.plan)}`);
    if (JSON.stringify(aliasPrepares) !== '["8001"]') violations.push(`bornAs prepare withheld: ${JSON.stringify(prepare.plan)}`);
    // Exercise the shared launch gate as well as the pure pre-assignment filter.
    // Num-only plans must recover the persisted bornAs identity at the IO boundary.
    await withRuntimeAdmissionTick(() => aliasPriority, async () => {
      setRuntimeAdmissionCards(aliasOrder.queue);
      for (const kind of ['build', 'prepare-item']) {
        if (!assertRuntimeAdmitted({ num: alias.num }, kind).admitted) violations.push(`bornAs ${kind} refused by shared admission`);
        let launches = 0;
        withRuntimeAdmission({ num: alias.num }, kind, () => { launches++; });
        if (launches !== 1) violations.push(`bornAs ${kind} launch withheld by shared gate`);
      }
      return {};
    });
    // A disallowed child must remain refused even if an older planner forwards it.
    await withRuntimeAdmissionTick(() => priority, async () => {
      setRuntimeAdmissionCards(queue);
      for (const kind of ['build', 'prepare-item']) {
        if (assertRuntimeAdmitted({ num: '7001' }, kind).admitted) violations.push(`unlisted child admitted for ${kind}`);
        let launches = 0;
        const result = withRuntimeAdmission({ num: '7001' }, kind, () => { launches++; });
        if (launches !== 0 || result?.outcome !== 'runtime-refused') violations.push(`unlisted child escaped ${kind} launch gate`);
      }
      return {};
    });
    return { violations };
  },
  judge(report) { return report.violations; },
};
