/** The owed ci-timeout-rerun executor refused every rerun because the daemon's own clone was behind origin/main. */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export default {
  id: 'owed-ci-rerun-stale-daemon-clone-refused',
  title: 'A review daemon whose own clone is behind main refuses every owed ci-timeout-rerun',
  card: 'owed ci rerun executor must not depend on the daemon clone being fresh',
  fixedBy: { sha: 'HEAD', where: 'review-daemon', paths: ['scripts/conveyor/owed-ci-rerun-executor.mjs'] },
  // Fix presence is decided by behaviour: a child process runs the tree's executor against a behind-clone verdict.
  fixPresent(root) {
    const code = `import { executeOwedCiReruns } from ${JSON.stringify(pathToFileURL(join(root, 'scripts/conveyor/owed-ci-rerun-executor.mjs')).href)};
const o = await executeOwedCiReruns({ rows: [{ kind: 'ci-timeout-rerun', prNumber: 1, timeoutRetry: { pr: 1 } }], repo: 'o/r', root: '/nonexistent',
  dispatchRetry: async () => ({ status: 'requested' }), checkStaleness: () => ({ action: 'warn', behind: 3, dirty: false }) });
process.stdout.write(String(o.requested.length));`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 20_000 });
    return r.status === 0 && r.stdout.trim() === '1';
  },
  async run() {
    const root = process.env.SOAK_TREE_ROOT || new URL('../../../../', import.meta.url).pathname;
    const { executeOwedCiReruns } = await import(pathToFileURL(join(root, 'scripts/conveyor/owed-ci-rerun-executor.mjs')).href);
    const violations = [];
    const rows = [{ kind: 'ci-timeout-rerun', prNumber: 7263, timeoutRetry: { pr: 7263 } }];
    const calls = [];
    const dispatchRetry = async (evidence) => { calls.push(evidence.pr); return { status: 'requested' }; };
    // Same injected verdict the old guard refused on: the clone is behind and cannot be fast-forwarded.
    const out = await executeOwedCiReruns({ rows, repo: 'o/r', root: '/nonexistent', dispatchRetry,
      checkStaleness: () => ({ action: 'warn', reason: 'not-auto-syncing', behind: 12, dirty: false }) });
    if (!calls.length || out.requested.length !== 1) violations.push('a clone behind origin/main refused the owed rerun');
    calls.length = 0;
    const offline = await executeOwedCiReruns({ rows, repo: 'o/r', root: '/nonexistent', dispatchRetry,
      checkStaleness: () => ({ offline: true }) });
    if (calls.length || offline.requested.length) violations.push('unknown main freshness (offline) executed a rerun');
    return { violations };
  },
  judge(report) { return report.violations; },
};
