import { mqSameHeadGuard } from '../../drain-queue-safety.mjs';
import { enqueuePr, ENQUEUE_MUTATION } from '../../merge-queue-enqueue.mjs';
import { createDrainMqFailureRecoveryIo, retryMqTimeoutOnHold } from '../../drain-mq-failure-recovery-io.mjs';
import { createMqFailureLedger, mqFailureLedgerStorage } from '../../mq-failure-ledger.mjs';
export const timeoutLog = `FAIL tests/example.test.mjs > timeout\nError: Test timed out in 5000ms.
Test Files 1 failed | 196 passed (197)\nTests 1 failed | 8410 passed\n##[error]Process completed with exit code 1.\n`;
export function timeoutFixture(root, options = {}) {
  const repo = 'fixture/timeout', pr = 42, head = 'a'.repeat(40), merge = 'b'.repeat(40);
  const event = { __typename: 'RemovedFromMergeQueueEvent', reason: 'failed_checks', createdAt: '2026-11-01T13:45:00Z',
    beforeCommit: { oid: merge, parents: { nodes: [{ oid: 'c'.repeat(40) }, { oid: head }] } } };
  const checks = [options.checkName ?? 'test-shard (1)', 'test', 'coverage-merge', ...(options.multipleFailures ? ['standards'] : [])].map((name, i) => ({ id: i + 1, name, head_sha: merge,
    status: 'completed', conclusion: 'failure', started_at: '2026-11-01T13:30:00Z', completed_at: '2026-11-01T13:40:00Z',
    details_url: `https://github.com/${repo}/actions/runs/201/job/${i + 1}` }));
  if (options.repeatedAttempt) checks.push({ ...checks[0], id: 5, started_at: '2026-11-01T13:41:00Z', completed_at: '2026-11-01T13:42:00Z', details_url: `https://github.com/${repo}/actions/runs/201/job/5` });
  let phase = 'original', mutations = 0;
  const exec = (command, args) => {
    if (command === 'git' && args[0] === 'ls-remote') return `${'c'.repeat(40)}\trefs/heads/main\n`;
    if (command !== 'gh') throw Error('unexpected command');
    if (args.some(arg => arg.includes('timelineItems')) && phase === 'unreadable') throw Error('timeline unreadable');
    if (args.some(arg => arg.includes('timelineItems'))) return JSON.stringify({ data: { repository: { pullRequest: { timelineItems: {
      nodes: phase === 'second' ? [event, { __typename: 'AddedToMergeQueueEvent' }, { ...event, createdAt: '2026-11-01T13:55:00Z' }] : options.repeats ? [event, event] : options.reentry ? [event, { __typename: 'AddedToMergeQueueEvent' }] : [...Array.from({ length: options.conflicts ?? 0 }, () => ({ ...event, reason: 'merge_conflict' })), event],
      pageInfo: { hasPreviousPage: false } } } } } });
    if (args.includes(`query=${ENQUEUE_MUTATION}`)) { mutations++; return JSON.stringify({ data: { enqueuePullRequest: { mergeQueueEntry: { id: 'entry' } } } }); }
    if (args.some(arg => arg.includes('isInMergeQueue')) && (options.queue === 'unreadable' || phase === 'queue unreadable')) throw Error('queue unreadable');
    if (args.some(arg => arg.includes('isInMergeQueue'))) return JSON.stringify({ data: { repository: { pullRequest: { isInMergeQueue: mutations > 0, headRefOid: options.queue === 'mismatched' || phase === 'queue mismatched' ? 'd'.repeat(40) : head } } } });
    if (args[0] === 'pr') return JSON.stringify({ id: 'PR_timeout', headRefOid: head, mergeStateStatus: phase === 'dirty' ? 'DIRTY' : 'CLEAN', baseRefName: 'main' });
    const endpoint = args.find(arg => arg.startsWith(`repos/${repo}/`));
    if (endpoint?.includes('/check-runs?')) {
      if (!endpoint.includes('filter=all')) throw Error('incomplete history');
      return JSON.stringify({ total_count: options.incomplete ? 101 : checks.length, check_runs: phase === 'attempt changed' ? checks.map(c => ({ ...c, started_at: '2026-11-01T13:31:00Z' })) : checks });
    }
    if (endpoint?.includes('/actions/workflows/ci.yml/runs?')) {
      if (options.mainCi === 'unavailable' || phase === 'main unavailable') throw Error('main CI unreadable');
      const runs = endpoint.includes('created=<') ? [] : [{ id: 301, head_sha: 'c'.repeat(40),
        path: '.github/workflows/ci.yml', head_branch: 'main', event: 'push', status: 'completed',
        conclusion: phase === 'main red' ? 'failure' : 'success', created_at: new Date().toISOString(), updated_at: new Date().toISOString() }];
      return JSON.stringify({ total_count: runs.length, workflow_runs: runs });
    }
    const job = /actions\/jobs\/([1234])$/.exec(endpoint ?? '');
    if (job) return JSON.stringify({ id: Number(job[1]), run_id: 201, head_sha: merge,
      name: checks[Number(job[1]) - 1].name, status: 'completed', conclusion: 'failure', run_attempt: 1,
      run_url: `https://api.github.com/repos/${repo}/actions/runs/201`, ...options.job });
    if (endpoint?.endsWith('/runs/201')) return JSON.stringify({ id: 201, head_sha: merge, event: 'merge_group',
      status: 'completed', conclusion: 'failure', run_attempt: 1, path: '.github/workflows/ci.yml', repository: { full_name: repo }, ...options.run });
    if (endpoint?.endsWith('/logs')) {
      if (options.unreadable || (!args.includes('--allow-escape-sequences'))) throw Error('logs unreadable');
      return endpoint.includes('/jobs/1/') ? options.text ?? timeoutLog
        : options.aggregateText ?? (endpoint.includes('/jobs/3/')
          ? '##[error]Unit shards did not succeed; refusing incomplete coverage.\n##[error]Process completed with exit code 1.'
          : '##[error]Unit shards did not succeed.\n##[error]Process completed with exit code 1.');
    }
    throw Error('unexpected IO');
  };
  return { guard: () => mqSameHeadGuard({ repo, pr, head, exec,
      now: Date.parse('2026-11-01T14:00:00Z'), quarantine: { readList: null } }), setTimeline: value => { phase = value; }, mutations: () => mutations,
    enqueue: sameHeadAdmission => enqueuePr({ repo, num: pr, headSha: head, cwd: root, exec, sameHeadAdmission,
      preparedSurface: { headSha: head, base: 'main', baseSha: 'c'.repeat(40), files: ['scripts/example.mjs'] } }),
    retry: () => retryMqTimeoutOnHold({ repo, pr, head, dryRun: options.dryRun ?? false,
    guard: options.guard ?? mqSameHeadGuard({ repo, pr, head, exec }),
    io: createDrainMqFailureRecoveryIo({ exec: options.stripEscape
      ? (file, args, opts) => exec(file, args.filter(arg => arg !== '--allow-escape-sequences'), opts) : exec, maxCalls: options.maxCalls,
      ledger: createMqFailureLedger({ io: options.ledgerIo ?? mqFailureLedgerStorage(root) }) }) }) };
}
