import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export default {
  id: 'review-speed-main-red-reads-not-memoized',
  title: 'unchanged main-red evidence is reused across review ticks',
  card: 'REVIEW-SPEED-MEMO',
  fixedBy: { sha: '16c167cd20e995e5adc94985e3aa4549fcae2d6d', where: 'lane/review-speed-memo', paths: ['scripts/conveyor/reconcile-pass.mjs'] },
  fixPresent(root) {
    return spawnSync('git', ['merge-base', '--is-ancestor', this.fixedBy.sha, 'HEAD'],
      { cwd: root, stdio: 'ignore', timeout: 5000 }).status === 0;
  },
  async run() {
    const root = process.env.SOAK_TREE_ROOT || new URL('../../../../', import.meta.url).pathname;
    const pass = await import(pathToFileURL(join(root, 'scripts/conveyor/reconcile-pass.mjs')).href);
    pass.resetMainRedMemo?.();
    const calls = { ahead: 0, green: 0, signature: 0 };
    const pr = { number: 1, headRefOid: 'memo-head', statusCheckRollup: [{ name: 'test',
      status: 'COMPLETED', conclusion: 'FAILURE', completedAt: '2026-10-01T00:00:00Z',
      detailsUrl: 'https://github.com/soak/memo/actions/runs/1/job/2' }] };
    const options = { repo: 'soak/memo', requiredChecks: ['test'],
      readMainRuns: () => [{ headSha: 'memo-main', status: 'queued', createdAt: '2026-10-02T00:00:00Z' }],
      readMainLatestCheckRuns: () => [{ name: 'test', conclusion: 'success', head_sha: 'memo-green' }],
      readAheadBy: () => { calls.ahead++; return 3; },
      readMainGreenFixFacts: () => { calls.green++; return { prContainsMainGreenSha: true, mergeBaseCheckRuns: null }; },
      readMainFixedSignatureFacts: () => { calls.signature++; return { signatures: [] }; },
      readJobAttempt: () => 1, readBudget: () => null };
    try {
      pass.enrichPrsWithMainRedFacts([pr], options);
      pass.enrichPrsWithMainRedFacts([pr], options);
      return { calls, violations: Object.entries(calls).filter(([, count]) => count !== 1)
        .map(([reader, count]) => `${reader} reader ran ${count} times for unchanged evidence`) };
    } finally { pass.resetMainRedMemo?.(); }
  },
  judge(report) { return report.violations; },
};
