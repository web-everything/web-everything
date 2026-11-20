/** A cleared failed merge-gate needs a new head through the production drain refresh. */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const SOURCE = 'scripts/lib/merge-queue-enqueue.mjs';
export default {
  id: 'stale-failed-merge-gate-blocks-drain',
  title: 'cleared failed merge-gate enters the guarded drain refresh once per head',
  card: 'PR #7106 / #7117 (2026-11-19)',
  fixedBy: { sha: 'HEAD', where: 'HEAD', paths: [SOURCE, 'scripts/merge-ai-prs.mjs'] },
  fixPresent(root) {
    return readFileSync(join(root, SOURCE), 'utf8').includes('failedRequiredGateRefresh');
  },
  async run({ sourceRoot = ROOT } = {}) {
    const { createPrestageWorld } = await import(pathToFileURL(join(sourceRoot, 'scripts/__tests__/fixtures/merge-ai-prs-prestage-world.mjs')).href);
    const world = createPrestageWorld((argv, options) => spawnSync(process.execPath,
      [join(sourceRoot, 'scripts/merge-ai-prs.mjs'), ...argv], options));
    const report = {};
    await world(async ({ pr, run, dir, slug }) => {
      pr.failedGate = true;
      pr.labels.push({ name: 'red-team:clear' });
      pr.statusCheckRollup = ['test', 'merge-gate'].map(name => ({ name, head_sha: pr.headRefOid,
        status: 'COMPLETED', conclusion: name === 'test' ? 'SUCCESS' : 'FAILURE' }));
      const env = { WE_MERGE_QUEUE_REFRESH_ON_STALE_MERGE_GATE: 'on',
        WE_MERGE_QUEUE_SKIP_REBASE_APPROVED_HUMAN_SURFACE: 'off' };
      const state = join(dir, 'groups.json');
      env.WE_DRAIN_CARD_GROUP_STATE = state;
      report.groupHolds = [];
      for (const role of ['source', 'combined', 'unreadable']) {
        writeFileSync(state, role === 'unreadable' ? '{broken' : JSON.stringify({ groups: [{
          id: 'fixture', repo: slug, pr: role === 'combined' ? 42 : 77,
          branch: role === 'combined' ? pr.headRefName : 'lane/card-group-fixture',
          sources: [{ num: role === 'source' ? 42 : 99, headSha: pr.headRefOid }], files: ['backlog/xfixture.md'],
        }], failed: {}, lastReconcileAt: Date.now() }));
        const held = await run(false, { env });
        report.groupHolds.push({ role, calls: held.calls, aborted: held.report.revalidationAborted });
      }
      writeFileSync(state, JSON.stringify({ groups: [], failed: {}, lastReconcileAt: Date.now() }));
      const first = await run(false, { env });
      const second = await run(false, { env });
      report.first = first.calls;
      report.second = second.calls;
      report.merged = first.report.merged;
    });
    return report;
  },
  judge(report) {
    const violations = [];
    const pushes = calls => calls.filter(a => a[0] === 'git' && a[1] === 'push');
    for (const held of report.groupHolds) {
      if (held.calls.some(a => a[0] === 'git' && ['commit-tree', 'push'].includes(a[1]) || a[0] === 'node')
        || !held.aborted.some(row => row.reason.includes('card group')))
        violations.push(`${held.role} card-group state did not hold the head before mutation`);
    }
    if (pushes(report.first).length !== 1 || !report.first.some(a => a[0] === 'git' && a[1] === 'merge-tree'))
      violations.push('failed gate did not rebuild through the production refresh path');
    if (pushes(report.second).length) violations.push('same head refreshed twice');
    if (report.merged.length) violations.push('repair changed the original skip into a merge');
    if ([...report.first, ...report.second].some(a => a.includes('PUT') || (a[0] === 'api' && a[1] === 'graphql' && a.some(x => x.startsWith('query=mutation')))))
      violations.push('repair bypassed the refresh path');
    return violations;
  },
};
