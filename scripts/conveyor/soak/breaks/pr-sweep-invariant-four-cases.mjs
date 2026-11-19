/** R437: replay the four stuck PR shapes through the production shell with injected IO. */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CONSTELLATION_REPOS } from '../../../lib/constellation-repos.mjs';
export default {
  id: 'pr-sweep-invariant-four-cases', title: 'Every open PR has an invariant decision, including fresh and blocked PRs',
  card: 'R437 PR sweep invariant',
  fixedBy: { sha: 'R437', where: 'PR sweep invariant', paths: ['scripts/conveyor/pr-sweep-core.mjs', 'scripts/conveyor/pr-blocked-by.mjs'] },
  fixPresent(root) {
    const file = join(root, 'scripts/conveyor/pr-blocked-by.mjs');
    return existsSync(file) && ['parseBlockedBy', 'buildBlockedMap', 'sortUnblockersFirst'].every(name => readFileSync(file, 'utf8').includes(`export function ${name}`))
      && readFileSync(join(root, 'scripts/conveyor/pr-sweep-core.mjs'), 'utf8').includes('export function evaluateInvariant');
  },
  async run() {
    const root = process.env.SOAK_TREE_ROOT || new URL('../../../../', import.meta.url).pathname;
    const { runPrSweep } = await import(pathToFileURL(join(root, 'scripts/conveyor/pr-sweep.mjs')).href);
    const now = Date.parse('2026-11-02T23:00:00Z'), repo = CONSTELLATION_REPOS.we.slug;
    const base = { repo, headRefOid: 'a'.repeat(40), updatedAt: new Date(now).toISOString(), changedFiles: 5, title: 'replay', labels: [] };
    const prs = [{ ...base, number: 6254 }, { ...base, number: 6193, body: 'Blocked by: #6244', labels: ['status:fixing'] },
      { ...base, number: 6244, labels: ['red-team:pending'], stateSince: now - 420 * 60000 },
      { ...base, number: 6268, labels: ['review:accepted'], changedFiles: 0, body: 'blocked by #6244' }];
    const report = await runPrSweep({ now, dryRun: true, env: {}, config: {},
      settings: { value: { repos: [repo], idleMinutes: 45, stuckAlertMinutes: 90 }, sources: {} },
      detector: async () => ({ enabled: false, items: [], errors: [], nextSeen: {} }),
      readPrs: () => prs, readQueue: () => ({ ready: [], rulingNeeded: [] }), readSignals: () => ({}), readPrevious: () => ({}) });
    const rows = report.decisions ?? [], violations = [];
    for (const [number, kind] of [[6254, 'no-labels'], [6193, 'waiting-on-blocked'], [6244, 'deadline-passed'], [6268, 'empty-diff']]) {
      if (rows.find(p => p.number === number)?.violation !== kind) violations.push(`#${number} missing ${kind}`);
    }
    if (rows[0]?.number !== 6244 || !rows[0]?.unblocks?.includes(6193)) violations.push('blocker does not sort first / lacks unblocks #6193');
    if (!rows.find(p => p.number === 6193)?.nextAction?.includes('blocked-by #6244')) violations.push('blocked-by #6244 missing');
    if (rows.find(p => p.number === 6268)?.nextAction !== 'close into card') violations.push('empty diff not closed into card');
    return { violations };
  },
  judge(report) { return report.violations; },
};
