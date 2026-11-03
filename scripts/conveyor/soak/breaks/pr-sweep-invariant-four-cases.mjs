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
    const prs = [{ ...base, number: 6254 }, { ...base, number: 6193, body: 'Blocked-by: #6244', labels: ['status:fixing'] },
      { ...base, number: 6244, labels: ['red-team:pending'], stateSince: now - 420 * 60000 },
      { ...base, number: 6268, labels: ['review:accepted'], changedFiles: 0, body: 'Blocked-by: #6244' }];
    const report = await runPrSweep({ now, dryRun: true, env: {}, config: {},
      settings: { value: { repos: [repo], idleMinutes: 45, stuckAlertMinutes: 90 }, sources: {} },
      detector: async () => ({ enabled: false, items: [], errors: [], nextSeen: {} }),
      readPrs: () => prs, readQueue: () => ({ ready: [], rulingNeeded: [] }), readSignals: () => ({}), readPrevious: () => ({}) });
    const rows = report.decisions ?? [], violations = [];
    for (const [number, kind] of [[6254, 'no-labels'], [6193, null], [6244, 'deadline-passed'], [6268, 'empty-diff']]) {
      if (rows.find(p => p.number === number)?.violation !== kind) violations.push(`#${number} missing ${kind}`);
    }
    if (rows[0]?.number !== 6244 || !rows[0]?.unblocks?.includes(6193)) violations.push('blocker does not sort first / lacks unblocks #6193');
    if (!rows.find(p => p.number === 6193)?.blockedBy?.includes(6244) || rows.find(p => p.number === 6193)?.nextAction !== 'fix') violations.push('blocked-by #6244 missing');
    if (rows.find(p => p.number === 6268)?.nextAction !== 'close into card') violations.push('empty diff not closed into card');
    // Additional replay: body-only reverse dependency and repeated fix-tool refusal.
    const refusal = value => ({ name: 'fix-dispatch-daemon', kind: 'refusal', at: now, head: base.headRefOid,
      reason: `dispatch-lane: the value for {{SCOPE}} ("${value}") has characters the brief cannot carry safely. Refusing.` });
    const added = await runPrSweep({ now, dryRun: true, env: {}, config: {},
      settings: { value: { repos: [repo], idleMinutes: 45, stuckAlertMinutes: 90, toolingDeadlineMinutes: 240 }, sources: {} },
      detector: async () => ({ enabled: false, items: [], errors: [], nextSeen: {} }),
      readPrs: () => [{ ...base, number: 6193, labels: ['status:fixing'] },
        { ...base, number: 6244, body: 'Unblocks: #6193', labels: ['review:pending'] },
        { ...base, number: 6270, labels: ['status:fixing'] }],
      readQueue: () => ({ ready: [], rulingNeeded: [] }), readPrevious: () => ({}),
      readSignals: () => Object.fromEntries([6193, 6270].map(n => [`${repo}#${n}`, { daemons: [refusal('a1'), refusal('b2')] }])) });
    if (added.decisions[0]?.number !== 6244 || !added.decisions[0]?.unblocks.includes(6193)) violations.push('body Unblocks missing');
    if (!added.decisions.find(p => p.number === 6193)?.violation?.startsWith('blocked-by-tooling (')
      || !added.decisions.find(p => p.number === 6193)?.blockedBy?.includes(6244)) violations.push('dependency annotation must preserve tooling finding');
    const tooling = added.decisions.find(p => p.number === 6270);
    if (tooling?.owner !== 'tooling' || !tooling?.violation?.startsWith('blocked-by-tooling (')
      || tooling?.state !== tooling?.violation || !tooling?.nextAction?.startsWith('fix tooling: ')
      || tooling?.deadline !== new Date(now + 240 * 60000).toISOString()) violations.push('repeated tooling refusal missing');
    return { violations };
  },
  judge(report) { return report.violations; },
};
