/** PR #3881 (2026-10-04): a fix waiter sat 3h+ in the scope-overlap queue behind repeated live ci-heal claims. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const FILE = 'we:scripts/conveyor/__tests__/reconcile-fix-dispatch.test.mjs';

export default {
  id: 'scope-overlap-waiter-starved-by-live-claims',
  title: 'PR #3881: a fix waiting 3h+ on one file stayed "waiting 3rd behind #3896, #3889" while those PRs held fresh live ci-heal claims',
  card: 'conveyor gap B — scope-overlap wait bound (PR #3881)',
  fixedBy: { sha: 'ef778e51b', where: 'lane/scope-overlap-aging', paths: ['scripts/conveyor/reconcile-fix-dispatch.mjs'] },
  fixPresent(root) { return readFileSync(join(root, 'scripts/conveyor/reconcile-fix-dispatch.mjs'), 'utf8').includes('export function resolveScopeOverlapMaxWaitMinutes'); },
  async run() {
    const root = process.env.SOAK_TREE_ROOT || new URL('../../../../', import.meta.url).pathname;
    const { filterFixesByInFlightScope } = await import(pathToFileURL(join(root, 'scripts/conveyor/reconcile-fix-dispatch.mjs')).href);
    const planned = [{ pr: 3881, itemNum: null, scope: [FILE], waitingSince: '2026-10-04T13:32:58Z' }];
    const claims = [{ meta: { pr: 3896, scope: [FILE] } }, { meta: { pr: 3889, scope: [FILE] } }];
    const out = filterFixesByInFlightScope(planned, [], claims, { now: Date.parse('2026-10-04T16:56:00Z') });
    const violations = out.planned.some((e) => e.pr === 3881) ? []
      : [`PR #3881 still refused after 203 min: ${JSON.stringify(out.refusals.map((r) => r.why))}`];
    return { violations };
  },
  judge(report) { return report.violations; },
};
