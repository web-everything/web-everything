/** PR #5087: a fixer pushes B while its live claim still records acquisition head A.
 * Replay the live region callback and scope gate, with hermetic head/region observations.
 * A edits line 10; B and the waiting candidate edit line 100. A must never release the hold.
 * The fix (62aa4e99a, in reconcile-fix-dispatch) later moved into createLiveRegionOverlap, so red-green.mjs
 * cannot reverse-apply it; the RED proof is re-adding `e.claim?.meta?.headSha ||` to the helper's headFor.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { filterFixesByInFlightScope } from '../../reconcile-fix-dispatch.mjs';
import { resolveFixScopePolicy, createLiveRegionOverlap } from '../../fix-scope-policy.mjs';

const SOURCE = 'scripts/conveyor/fix-scope-policy.mjs';
const F = 'we:x';

export default {
  id: 'fix-scope-stale-claim-head',
  title: 'region scope observes the current fixer head rather than its acquisition head',
  card: 'PR #5087',
  fixedBy: { sha: '62aa4e99a', where: 'lane/scope-hold-policy', paths: ['scripts/conveyor/reconcile-fix-dispatch.mjs'] },
  // Soak probes are synchronous source checks; run() is the behavioural proof. Any headSha read in the helper is stale.
  fixPresent(root) {
    const source = readFileSync(join(root, SOURCE), 'utf8');
    const start = source.indexOf('export function createLiveRegionOverlap');
    return start >= 0 && !/headSha/.test(source.slice(start, source.indexOf('\n}\n', start)));
  },
  async run() {
    const now = Date.parse('2026-10-13T02:17:23Z');
    const policy = resolveFixScopePolicy({ env: {}, platform: {}, readTool: () => ({ fixScope: { priorityBypass: false } }) });
    const violations = [];
    for (const [name, known, observed] of [['current-entry', 'B', null], ['claim-only', null, 'B'], ['unreadable', null, null]]) {
      const heads = [];
      const regionReader = {
        hunksFor(sha) {
          heads.push(sha);
          const line = sha === 'A' ? 10 : 100;
          return sha ? new Map([['x', [[line, line]]]]) : null;
        },
        mergeConflicts: (a, b) => a && b ? b !== 'A' : null,
      };
      const holderEntries = new Map([[1, { headRefOid: known }]]);
      const regionOverlap = createLiveRegionOverlap({ holderEntries, readPrHeads: () => new Map([[1, observed]]), regionReader, policy, root: '/unused' });
      const result = filterFixesByInFlightScope([{ pr: 2, scope: [F], headRefOid: 'C' }], [],
        [{ heartbeatAt: new Date(now).toISOString(), meta: { pr: 1, scope: [F], headSha: 'A' } }],
        { now, maxWaitMinutes: null, rebaseExempt: null, policy, holderEntries, regionOverlap });
      if (result.planned.length || heads.includes('A')) violations.push(`${name}: stale claim released the hold (heads ${heads.join(',')})`);
    }
    return { violations };
  },
  judge: report => report.violations,
};
