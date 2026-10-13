/** PR #5087: a fixer pushes B while its live claim still records acquisition head A.
 * Replay the live region closure and scope gate, with hermetic head/region observations.
 * A edits line 10; B and the waiting candidate edit line 100. A must never release the hold.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { filterFixesByInFlightScope } from '../../reconcile-fix-dispatch.mjs';
import { resolveFixScopePolicy, regionOverlapDecision } from '../../fix-scope-policy.mjs';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SOURCE = 'scripts/conveyor/reconcile-fix-dispatch.mjs';
const F = 'we:x';

export default {
  id: 'fix-scope-stale-claim-head',
  title: 'region scope observes the current fixer head rather than its acquisition head',
  card: 'PR #5087',
  fixedBy: { sha: 'HEAD', where: 'lane/scope-hold-policy', paths: [SOURCE] },
  fixPresent(root) {
    const source = readFileSync(join(root, SOURCE), 'utf8');
    const headFor = source.slice(source.indexOf('  const headFor ='), source.indexOf('  const regionOverlap ='));
    return !headFor.includes('e.claim?.meta?.headSha');
  },
  async run() {
    const source = readFileSync(join(ROOT, SOURCE), 'utf8');
    const start = source.indexOf('  const observedHeads = new Map();');
    const end = source.indexOf('\n  };', source.indexOf('  const regionOverlap =', start)) + '\n  };'.length;
    if (start < 0 || end <= start) throw new Error('live region closure not found');
    const makeOverlap = new Function('holderEntries', 'readPrHeads', 'regionReader', 'scopePolicy', 'regionOverlapDecision', 'root', `${source.slice(start, end)}\nreturn regionOverlap;`);
    const now = Date.parse('2026-10-13T02:17:23Z');
    const policy = resolveFixScopePolicy({ env: {}, platform: {}, readTool: () => ({ fixScope: { priorityBypass: false } }) });
    const violations = [];
    for (const [name, known, observed] of [['current-entry', 'B', null], ['claim-only', null, 'B'], ['unreadable', null, null]]) {
      const heads = [];
      const reader = {
        hunksFor(sha) {
          heads.push(sha);
          const line = sha === 'A' ? 10 : 100;
          return sha ? new Map([['x', [[line, line]]]]) : null;
        },
        mergeConflicts: (a, b) => a && b ? b !== 'A' : null,
      };
      const holderEntries = new Map([[1, { headRefOid: known }]]);
      const overlap = makeOverlap(holderEntries, () => new Map([[1, observed]]), reader, policy, regionOverlapDecision, ROOT);
      const result = filterFixesByInFlightScope([{ pr: 2, scope: [F], headRefOid: 'C' }], [],
        [{ heartbeatAt: new Date(now).toISOString(), meta: { pr: 1, scope: [F], headSha: 'A' } }],
        { now, maxWaitMinutes: null, rebaseExempt: null, policy, holderEntries, regionOverlap: overlap });
      if (result.planned.length || heads.includes('A')) violations.push(`${name}: stale claim released the hold (heads ${heads.join(',')})`);
    }
    return { violations };
  },
  judge: report => report.violations,
};
