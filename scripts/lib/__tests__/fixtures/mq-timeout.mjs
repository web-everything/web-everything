import { mqSameHeadGuard } from '../../drain-queue-safety.mjs';
import { mqFailureLedgerStorage } from '../../mq-failure-ledger.mjs';

export const timeoutLog = ` FAIL  scripts/operations/__tests__/update-branch.test.mjs > update-branch > declares required CLI inputs and prints exactly one JSON line through the engine
Error: Test timed out in 5000ms.
Test Files 1 failed | 196 passed (197)
Tests 1 failed | 8410 passed
##[error]Process completed with exit code 1.
`;
export function timeoutFixture(root, { text = timeoutLog, unreadable = false, repeats = false, dryRun = false, preflight = false, ledger, qualifying = true, runEvent = 'merge_group', extraHeadCheck, undatedPass = false, quarantine, boundedLogs = false } = {}) {
  const repo = 'fixture/timeout', pr = 42, head = 'a'.repeat(40), merge = 'b'.repeat(40);
  const event = { __typename: 'RemovedFromMergeQueueEvent', reason: 'failed_checks', createdAt: '2026-11-01T13:45:00Z',
    beforeCommit: { oid: merge, parents: { nodes: [{ oid: 'c'.repeat(40) }, { oid: head }] } } };
  const checks = ['test-shard (1)', 'test', 'coverage-merge'].map((name, i) => ({
    id: 1 + i, name, head_sha: merge, status: 'completed', conclusion: 'failure',
    started_at: '2026-11-01T13:30:00Z', completed_at: '2026-11-01T13:40:00Z',
    details_url: `https://github.com/${repo}/actions/runs/201/job/${i + 1}`, output: {},
  }));
  const headChecks = checks.map((c, i) => ({ ...c, id: 11 + i, head_sha: head, conclusion: 'success',
    completed_at: undatedPass ? undefined : '2026-11-01T13:50:00Z',
    details_url: `https://github.com/${repo}/actions/runs/202/job/${11 + i}` }));
  if (extraHeadCheck) headChecks.push({ ...headChecks[0], id: 20, ...extraHeadCheck });
  const main = { id: 203, head_sha: 'c'.repeat(40), path: '.github/workflows/ci.yml', head_branch: 'main', event: 'push',
    status: 'completed', conclusion: 'success', created_at: '2026-11-01T13:46:00Z', updated_at: '2026-11-01T13:55:00Z' };
  const report = JSON.stringify({ testResults: [{ name: 'scripts/operations/__tests__/update-branch.test.mjs',
    assertionResults: [{ ancestorTitles: ['update-branch'], title: 'declares required CLI inputs and prints exactly one JSON line through the engine', status: 'passed' }] }] });
  const writes = [], logReads = [];

  const exec = (command, args, options) => {
    if (command === 'funzip') return options.input;
    if (command !== 'gh') throw Error('unexpected process');
    if (args.includes('POST')) { writes.push(args); throw Error('unexpected mutation'); }
    if (args.some(arg => arg.includes('isInMergeQueue'))) return JSON.stringify({ data: { repository: { pullRequest: { isInMergeQueue: false, headRefOid: head } } } });
    if (args.some(arg => arg.includes('timelineItems'))) return JSON.stringify({ data: { repository: { pullRequest: { timelineItems: {
      nodes: repeats ? [event, { __typename: 'AddedToMergeQueueEvent' }, event] : [event], pageInfo: { hasPreviousPage: false },
    } } } } });
    if (args.includes('mergeStateStatus,headRefOid')) return JSON.stringify({ headRefOid: head, mergeStateStatus: 'CLEAN' });
    const endpoint = args.find(arg => arg.startsWith(`repos/${repo}/`));
    if (endpoint?.includes('/check-runs?')) {
      const rows = endpoint.includes(`/commits/${head}/`) ? headChecks : checks;
      return JSON.stringify({ total_count: rows.length, check_runs: rows });
    }
    if (qualifying && endpoint?.includes('/actions/workflows/ci.yml/runs')) {
      const rows = endpoint.includes('created=<') ? [] : [main];
      return JSON.stringify({ total_count: rows.length, workflow_runs: rows });
    }
    if (endpoint?.endsWith('/actions/runs/202')) return JSON.stringify({ id: 202, head_sha: head, path: '.github/workflows/ci.yml' });
    if (endpoint?.endsWith('/actions/jobs/11')) return JSON.stringify({ run_id: 202, head_sha: head, name: headChecks[0].name });
    const art = /actions\/runs\/(202|203)\/artifacts/.exec(endpoint ?? '');
    if (art) return JSON.stringify({ artifacts: [{ id: Number(art[1]), name: 'timing-unit-1', expired: false,
      workflow_run: { id: Number(art[1]), head_sha: art[1] === '202' ? head : main.head_sha } }] });
    if (/actions\/artifacts\/(202|203)\/zip$/.test(endpoint ?? '')) return report;
    const job = /\/actions\/jobs\/([1-3])$/.exec(endpoint ?? '');
    if (job) return JSON.stringify({ id: Number(job[1]), run_id: 201, head_sha: merge,
      name: checks[Number(job[1]) - 1].name, conclusion: 'failure',
      run_url: `https://api.github.com/repos/${repo}/actions/runs/201` });
    if (endpoint?.endsWith('/actions/runs/201')) return JSON.stringify({ id: 201, head_sha: merge,
      event: runEvent, path: '.github/workflows/ci.yml', repository: { full_name: repo } });
    if (endpoint?.endsWith('/logs')) {
      logReads.push(options.maxBuffer);
      const value = endpoint.includes('/jobs/1/') ? text : '##[error]Unit shards did not succeed.\n##[error]Process completed with exit code 1.';
      if (boundedLogs && Buffer.byteLength(value) > options.maxBuffer) throw Error('maxBuffer exceeded');
      if (unreadable) throw Error('logs expired');
      return value;
    }
    throw Error(`unavailable fixture evidence: ${endpoint}`);
  };
  return { writes, logReads, guard: () => mqSameHeadGuard({ repo, pr, head, exec, dryRun,
    allowAlreadyQueued: preflight, timeoutLedger: ledger ?? mqFailureLedgerStorage(root), quarantine: quarantine ?? { readList: null },
    now: Date.parse('2026-11-01T14:00:00Z') }) };
}
