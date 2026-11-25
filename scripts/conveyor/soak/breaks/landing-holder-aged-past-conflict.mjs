import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
export default {
  id: 'landing-holder-aged-past-conflict',
  title: 'aging retains and escalates a confirmed landing-holder conflict',
  card: 'LANDING-HOLDER-TIMEOUT v2',
  fixedBy: { sha: 'uncommitted', where: 'landing holder aging protection', paths: ['scripts/conveyor/reconcile-fix-dispatch.mjs'] },
  fixPresent() { return true; },
  async run() {
    const root = process.env.SOAK_TREE_ROOT || new URL('../../../../', import.meta.url).pathname;
    const { filterFixesByInFlightScope } = await import(pathToFileURL(join(root, 'scripts/conveyor/reconcile-fix-dispatch.mjs')).href);
    const { resolveFixScopePolicy } = await import(pathToFileURL(join(root, 'scripts/conveyor/fix-scope-policy.mjs')).href);
    const now = Date.parse('2026-11-25T12:00:00Z'), since = new Date(now - 120 * 60000).toISOString();
    const scope = ['we:scripts/conveyor/reconcile-fix-dispatch.mjs'];
    const out = filterFixesByInFlightScope([{ pr: 80, scope, waitingSince: since }], [], [], {
      now, rebaseExempt: null,
      policy: resolveFixScopePolicy({ env: {}, platform: {}, readTool: () => ({ fixScope: { priorityBypass: false } }) }),
      regionOverlap: () => ({ overlap: true, conflict: true, why: 'confirmed trial merge conflict' }),
      holderState: () => ({ labels: ['review:accepted'] }), landingHolders: [{ pr: 90, scope, headRefOid: 'head' }],
      landingBlockedSince: new Map([['80:90', since]]),
    });
    const violations = [];
    if (out.planned.length || out.refusals[0]?.kind !== 'scope-overlap') violations.push('waiter admitted past confirmed landing conflict');
    if (out.landingEscalations?.length !== 1 || out.landingEscalations[0].holder !== 90) violations.push('stuck holder was not escalated');
    return { violations };
  },
  judge(report) { return report.violations; },
};
