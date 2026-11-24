import { mqSameHeadGuard } from '../../drain-queue-safety.mjs';
import { mqFailureLedgerStorage } from '../../mq-failure-ledger.mjs';

export const timeoutLog = ` FAIL  scripts/operations/__tests__/update-branch.test.mjs > update-branch > declares required CLI inputs and prints exactly one JSON line through the engine
Error: Test timed out in 5000ms.
Test Files 1 failed | 196 passed (197)
Tests 1 failed | 8410 passed
##[error]Process completed with exit code 1.
`;
export function timeoutFixture(root, { text = timeoutLog, unreadable = false, repeats = false, dryRun = false, preflight = false, ledger } = {}) {
  const repo = 'fixture/timeout', pr = 42, head = 'a'.repeat(40), merge = 'b'.repeat(40);
  const event = { __typename: 'RemovedFromMergeQueueEvent', reason: 'failed_checks', createdAt: '2026-11-01T13:45:00Z',
    beforeCommit: { oid: merge, parents: { nodes: [{ oid: 'c'.repeat(40) }, { oid: head }] } } };
  const checks = ['unit (1)', 'test', 'coverage-merge'].map((name, i) => ({
    id: 100 + i, name, head_sha: merge, status: 'completed', conclusion: 'failure',
    started_at: '2026-11-01T13:30:00Z', completed_at: '2026-11-01T13:40:00Z',
    details_url: `https://github.com/${repo}/actions/runs/201/job/${i + 1}`, output: {},
  }));
  const writes = [];
  const exec = (command, args) => {
    if (command !== 'gh') throw Error('unexpected process');
    if (args.includes('POST')) { writes.push(args); throw Error('unexpected mutation'); }
    if (args.some(arg => arg.includes('isInMergeQueue'))) return JSON.stringify({ data: { repository: { pullRequest: { isInMergeQueue: false, headRefOid: head } } } });
    if (args.some(arg => arg.includes('timelineItems'))) return JSON.stringify({ data: { repository: { pullRequest: { timelineItems: {
      nodes: repeats ? [event, { __typename: 'AddedToMergeQueueEvent' }, event] : [event], pageInfo: { hasPreviousPage: false },
    } } } } });
    if (args.includes('mergeStateStatus,headRefOid')) return JSON.stringify({ headRefOid: head, mergeStateStatus: 'CLEAN' });
    const endpoint = args.find(arg => arg.startsWith(`repos/${repo}/`));
    if (endpoint?.includes('/check-runs?')) return JSON.stringify({ total_count: checks.length, check_runs: checks });
    const job = /\/actions\/jobs\/([1-3])$/.exec(endpoint ?? '');
    if (job) return JSON.stringify({ id: Number(job[1]), run_id: 201, head_sha: merge,
      name: checks[Number(job[1]) - 1].name, conclusion: 'failure',
      run_url: `https://api.github.com/repos/${repo}/actions/runs/201` });
    if (endpoint?.endsWith('/actions/runs/201')) return JSON.stringify({ id: 201, head_sha: merge,
      event: 'merge_group', path: '.github/workflows/ci.yml', repository: { full_name: repo } });
    if (endpoint?.endsWith('/logs')) {
      if (unreadable) throw Error('logs expired');
      return endpoint.includes('/jobs/1/') ? text : '##[error]Unit shards did not succeed.\n##[error]Process completed with exit code 1.';
    }
    throw Error(`unavailable fixture evidence: ${endpoint}`);
  };
  return { writes, guard: () => mqSameHeadGuard({ repo, pr, head, exec, dryRun,
    allowAlreadyQueued: preflight, timeoutLedger: ledger ?? mqFailureLedgerStorage(root), quarantine: { readList: null },
    now: Date.parse('2026-11-01T14:00:00Z') }) };
}
