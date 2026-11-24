import { expect, it, vi } from 'vitest';
import { classifyMqTimeoutLog } from '../mq-failure-evidence.mjs';
import { readMqTimeoutFailure } from '../drain-mq-flake-rerun.mjs';
import { decideMqSameHead } from '../drain-queue-safety.mjs';
import { timeoutLog } from './fixtures/mq-timeout.mjs';

const repo = 'fixture/timeout', commit = 'b'.repeat(40), head = 'a'.repeat(40);
const exit = '##[error]Process completed with exit code 1.';
const aggregate = `##[group]Run if [ "failure" != "success" ]; then\n##[endgroup]\n##[error]Unit shards did not succeed.\n${exit}`;
it.each([false, true])('timeout alone cannot authorize same-head retry (main green: %s)', mainGreen => {
  const timeline = { hasPreviousPage: false, nodes: [{ __typename: 'RemovedFromMergeQueueEvent', reason: 'failed_checks',
    beforeCommit: { parents: { nodes: [{ oid: 'c'.repeat(40) }, { oid: head }] } } }] };
  expect(decideMqSameHead({ pr: 42, head, timeline,
    retryEvidence: { infra: 'mq-flake-timeout', mergeState: 'CLEAN', mainGreen } }).hold).toBe(true);
});
it('captured output cannot conceal an independent assertion', () => {
  expect(classifyMqTimeoutLog(`stdout | tests/a.test.mjs > a\nAssertionError: independent failure\n\n${timeoutLog}`, 'unit')).toBe('unknown');
});
it.each(['Errors 1 error', 'src/a.ts(1,2): error TS2322: Type mismatch', 'unrecognized output'])(
  'unknown runner evidence refuses timeout-only classification: %s', extra => {
    expect(classifyMqTimeoutLog(`${extra}\n${timeoutLog}`, 'unit')).toBe('unknown');
  });
it('duplicate test identities cannot prove a two-failure summary', () => {
  const block = timeoutLog.split('Test Files')[0];
  expect(classifyMqTimeoutLog(block + timeoutLog.replace('Tests 1 failed', 'Tests 2 failed'), 'unit')).toBe('unknown');
});
it.each(['FAIL tests/other.test.mjs > other', 'Tests 1 failed', 'Test Files 1 failed'])(
  'grouped aggregate refuses independent evidence: %s', extra => {
    expect(classifyMqTimeoutLog(aggregate.replace(exit, `${extra}\n${exit}`), 'test')).toBe('unknown');
  });
it.each(['##[error]Unit shards did not succeed.', aggregate.replace(`\n${exit}`, '')])(
  'aggregate requires a final exit annotation: %s', text => {
    expect(classifyMqTimeoutLog(text, 'test')).toBe('unknown');
  });

const check = { name: 'unit', conclusion: 'failure', head_sha: commit,
  details_url: `https://github.com/${repo}/actions/runs/201/job/1` };
const run = { id: 201, head_sha: commit, event: 'merge_group', path: '.github/workflows/ci.yml', repository: { full_name: repo } };
const job = { id: 1, run_id: 201, head_sha: commit, name: 'unit', conclusion: 'failure',
  run_url: `https://api.github.com/repos/${repo}/actions/runs/201` };
function read(overrides = {}, requireEscapeFlag = false) {
  const exec = vi.fn((_file, args) => {
    const endpoint = args.find(arg => arg.startsWith(`repos/${repo}/`));
    if (endpoint.endsWith('/logs')) {
      if (requireEscapeFlag && !args.includes('--allow-escape-sequences'))
        throw new Error('the response contains terminal escape sequences; pass --allow-escape-sequences');
      return timeoutLog;
    }
    return JSON.stringify(endpoint.includes('/jobs/') ? { ...job, ...overrides.job } : { ...run, ...overrides.run });
  });
  const result = readMqTimeoutFailure({ failed: [check], attempts: { candidates: [1] }, repo, exec, spend: vi.fn() });
  return { result, exec };
}
it.each([
  ['job head', { job: { head_sha: head } }], ['job run', { job: { run_id: 202 } }],
  ['job id', { job: { id: 2 } }], ['job repo', { job: { run_url: 'https://api.github.com/repos/other/repo/actions/runs/201' } }],
  ['run head', { run: { head_sha: head } }], ['run repo', { run: { repository: { full_name: 'other/repo' } } }],
  ['run event', { run: { event: 'pull_request' } }], ['run id', { run: { id: 202 } }],
  ['workflow', { run: { path: '.github/workflows/other.yml' } }], ['missing metadata', { run: { event: undefined } }],
])('timeout logs require validated Actions metadata: %s', (_label, overrides) => {
  const { result, exec } = read(overrides);
  expect(result).toBe(false);
  expect(exec.mock.calls.some(([, args]) => args[1].endsWith('/logs'))).toBe(false);
});
it('accepts complete timeout evidence only after matching Actions metadata', () => {
  expect(read().result).toBe(true);
});
it('accepts a complete known aggregate gate transcript', () => {
  expect(classifyMqTimeoutLog(aggregate, 'test')).toBe('upstream');
});
it('counts distinct tests in the same file', () => {
  const block = timeoutLog.split('Test Files')[0].replace('> update-branch >', '> another suite >');
  expect(classifyMqTimeoutLog(block + timeoutLog.replace('Tests 1 failed', 'Tests 2 failed'), 'unit')).toBe('mq-flake-timeout');
});
it.each(['x'.repeat(2049), 'x'.repeat(4 * 1024 * 1024)])('oversized timeout evidence requires operator inspection', text => {
  expect(classifyMqTimeoutLog(text + timeoutLog, 'unit')).toBe('unknown');
});
it.each(['metadata unreadable', 'metadata malformed', 'budget exhausted'])(
  'unavailable metadata or budget refuses before log IO: %s', mode => {
    const exec = vi.fn(() => { if (mode === 'metadata unreadable') throw Error('unreadable'); return '{'; });
    const spend = () => { if (mode === 'budget exhausted') throw Error('operator inspection required'); };
    expect(readMqTimeoutFailure({ failed: [check], attempts: { candidates: [1] }, repo, exec, spend })).toBe(false);
    expect(exec.mock.calls.some(([, args]) => args[1].endsWith('/logs'))).toBe(false);
  });
it('more than ten failed jobs refuse without IO', () => {
  const exec = vi.fn(), spend = vi.fn();
  expect(readMqTimeoutFailure({ failed: Array(11).fill(check), attempts: { candidates: [1] }, repo, exec, spend })).toBe(false);
  expect(exec).not.toHaveBeenCalled();
  expect(spend).not.toHaveBeenCalled();
});

it('flake-admission reads job logs when gh requires the escape-sequence flag', () => {
  const { result, exec } = read({}, true);
  expect(result).toBe(true);
  expect(exec.mock.calls.find(([, args]) => args.some(arg => /\/logs$/.test(arg)))[1])
    .toContain('--allow-escape-sequences');
});
