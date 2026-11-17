/** B35: a merge-group Checkout failure was held as non-infrastructure despite green main and a CLEAN PR. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HEAD = 'a'.repeat(40);
const GROUP = 'b'.repeat(40);
const PRIOR = 'c'.repeat(40);
const PATH = 'scripts/lib/drain-queue-safety.mjs';

export default {
  id: 'drain-setup-step-failure-not-infra',
  title: 'Checkout failure earns an infrastructure retry; test failures and unreadable steps stay held',
  card: 'B35 — merge-queue setup-step infrastructure proof',
  fixedBy: { sha: 'pending', where: 'B35', paths: [PATH] },
  fixPresent(root) { return readFileSync(join(root, PATH), 'utf8').includes('mqSetupFailure'); },
  async run() {
    const root = process.env.SOAK_TREE_ROOT || fileURLToPath(new URL('../../../../', import.meta.url));
    const { mqSameHeadGuard } = await import(pathToFileURL(join(root, PATH)).href);
    const repo = 'fixture/drain', pr = 42;
    const violations = [];
    for (const variant of ['checkout', 'test-failure', 'unreadable-steps']) {
      const logs = [], unexpected = [];
      const job = {
        id: 31, run_id: 20, name: 'test-shard (1)', head_sha: GROUP,
        status: 'completed', conclusion: 'failure',
        steps: [
          { number: 1, name: 'Set up job', status: 'completed', conclusion: 'success' },
          { number: 2, name: 'Checkout', status: 'completed', conclusion: variant === 'test-failure' ? 'success' : 'failure' },
          { number: 3, name: 'Run unit tests', status: 'completed', conclusion: variant === 'test-failure' ? 'failure' : 'skipped' },
          { number: 4, name: 'Complete job', status: 'completed', conclusion: 'success' },
        ],
      };
      const check = { id: 21, name: job.name, head_sha: GROUP, status: 'completed', conclusion: 'failure',
        details_url: `https://github.com/${repo}/actions/runs/20/job/31`, output: { title: '', summary: '' } };
      const runs = [
        { id: 12, created_at: '2026-11-01T13:00:00Z' },
        { id: 11, created_at: '2026-11-01T11:00:00Z' },
      ].map(run => ({ ...run, updated_at: run.created_at, status: 'completed', conclusion: 'success',
        path: '.github/workflows/ci.yml', head_branch: 'main', event: 'push' }));
      const exec = (command, args) => {
        const json = JSON.stringify;
        if (command === 'gh') {
          if (args.some(arg => arg.includes('isInMergeQueue'))) return json({ data: { repository: {
            pullRequest: { isInMergeQueue: false, headRefOid: HEAD },
          } } });
          if (args.some(arg => arg.includes('timelineItems'))) return json({ data: { repository: { pullRequest: {
            timelineItems: { pageInfo: { hasPreviousPage: false }, nodes: [{
              __typename: 'RemovedFromMergeQueueEvent', reason: 'failed_checks', createdAt: '2026-11-01T12:00:00Z',
              beforeCommit: { oid: GROUP, parents: { nodes: [{ oid: PRIOR }, { oid: HEAD }] } },
            }] },
          } } } });
          if (args.includes('mergeStateStatus,headRefOid')) return json({ headRefOid: HEAD, mergeStateStatus: 'CLEAN' });
          const endpoint = args.find(arg => arg.startsWith(`repos/${repo}/`));
          if (endpoint?.startsWith(`repos/${repo}/commits/${GROUP}/check-runs?`))
            return json({ total_count: 1, check_runs: [check] });
          // No successful PR-head run can supply an unrelated flake exemption.
          if (endpoint?.startsWith(`repos/${repo}/commits/${HEAD}/check-runs?`))
            return json({ total_count: 1, check_runs: [{ ...check, head_sha: HEAD }] });
          if (endpoint === `repos/${repo}/actions/jobs/31`) {
            if (variant === 'unreadable-steps') throw new Error('job metadata unavailable');
            return json(job);
          }
          // No runner-loss signature: the failed step itself must supply the proof.
          if (endpoint === `repos/${repo}/actions/jobs/31/logs`) return 'Checkout fetch failed.\n';
          if (endpoint?.startsWith(`repos/${repo}/actions/workflows/ci.yml/runs?`)) {
            const before = new URLSearchParams(endpoint.split('?')[1]).get('created')?.replace(/^</, '');
            const selected = before ? runs.filter(run => Date.parse(run.created_at) < Date.parse(before)) : runs;
            return json({ total_count: selected.length, workflow_runs: selected });
          }
        }
        unexpected.push(`${command} ${args.join(' ')}`);
        throw new Error('unexpected fixture IO');
      };
      const decision = mqSameHeadGuard({ repo, pr, head: HEAD, exec, log: line => logs.push(line),
        now: Date.parse('2026-11-01T14:00:00Z'), quarantine: { readList: null } });
      if (variant === 'checkout') {
        if (decision.hold || !logs.some(line => line.includes('failed_checks infra retry 1/2')))
          violations.push('Checkout failure was held instead of receiving its bounded infrastructure retry');
      } else if (!decision.hold) violations.push(`${variant}: incomplete or non-infrastructure step proof released the hold`);
      if (unexpected.length) violations.push(`${variant}: unexpected fixture IO: ${unexpected.join('; ')}`);
    }
    return { violations };
  },
  judge(report) { return report.violations; },
};
