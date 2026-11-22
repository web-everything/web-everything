/** Legacy untimed claims stranded #7310, #7315 and #7321 without update-branch or a CI run. */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SOURCE = 'scripts/lib/drain-queue-safety.mjs';

function probe({ mqSameHeadGuard, createMqSameHeadRefreshStore }, { mkdtempSync, writeFileSync, rmSync, join }) {
  const dir = mkdtempSync(join(process.env.TMPDIR, 'mq-unexecuted-refresh-'));
  try {
    const repo = 'fixture/drain', pr = 7310, head = 'a'.repeat(40);
    const path = join(dir, 'state.json'), key = `${repo}#${pr}@${head}`;
    writeFileSync(path, JSON.stringify([key]));
    let updates = 0;
    const exec = (_file, args) => {
      if (args.some(a => a.includes('isInMergeQueue'))) return JSON.stringify({ data: { repository: {
        pullRequest: { headRefOid: head, isInMergeQueue: false } } } });
      if (args.some(a => a.includes('timelineItems'))) return JSON.stringify({ data: { repository: { pullRequest: {
        timelineItems: { nodes: [{ __typename: 'RemovedFromMergeQueueEvent', reason: 'failed_checks',
          beforeCommit: { parents: { nodes: [{ oid: 'b'.repeat(40) }, { oid: head }] } } }],
        pageInfo: { hasPreviousPage: false } } } } } });
      if (args.includes('PUT')) { updates++; return '{}'; }
      if (args[0] === 'pr') return JSON.stringify({ headRefOid: head, mergeStateStatus: 'CLEAN',
        statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }], labels: ['ready-to-merge'] });
      if (args.includes(`repos/${repo}/actions/runs?head_sha=${head}&per_page=100`))
        return JSON.stringify({ total_count: 0, workflow_runs: [] });
      throw new Error('unexpected probe IO');
    };
    const decisions = Array.from({ length: 3 }, () => mqSameHeadGuard({ repo, pr, head, exec,
      refresh: { store: createMqSameHeadRefreshStore({ path }), allow: () => true } }));
    const violations = [];
    if (updates !== 1) violations.push(`legacy claim produced ${updates} update-branch calls, expected exactly one retry`);
    if (decisions.some(d => d.hold !== true)) violations.push('same-head failure admission was released');
    return violations;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

export default {
  id: 'mq-same-head-unexecuted-refresh-retry',
  title: 'an unexecuted legacy MQ refresh gets one retry and never a second retry',
  card: 'delivery blockers #7310, #7315, #7321 (recorded refresh never executed)',
  fixedBy: { sha: 'pending', where: 'mq-same-head-unexecuted-refresh-retry', paths: [SOURCE] },
  fixPresent(root) {
    try {
      const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
        import { pathToFileURL } from 'node:url';
        import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
        import { join } from 'node:path';
        const safety = await import(pathToFileURL(process.argv[1]).href);
        process.stdout.write(JSON.stringify((${probe.toString()})(safety, { mkdtempSync, writeFileSync, rmSync, join })));
      `, resolve(root, SOURCE)], { encoding: 'utf8', timeout: 10000, maxBuffer: 64 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'] });
      const violations = JSON.parse(output);
      return Array.isArray(violations) && violations.length === 0;
    } catch { return false; }
  },
  async run({ log } = {}) {
    const safety = await import('../../../lib/drain-queue-safety.mjs');
    const violations = probe(safety, { mkdtempSync, writeFileSync, rmSync, join });
    log?.(`mq unexecuted-refresh retry: ${violations.length} violation(s)`);
    return { violations };
  },
  judge(report) { return report.violations; },
};
