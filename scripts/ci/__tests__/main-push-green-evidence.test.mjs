// @vitest-environment node
import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';
import { mqSameHeadGuard } from '../../lib/drain-queue-safety.mjs';

const jobs = yaml.load(readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8')).jobs;
const head = 'a'.repeat(40), merged = 'b'.repeat(40);
const now = Date.parse('2026-11-20T12:00:00Z');

function evidence(conclusion) {
  const reads = [];
  const exec = (_, args) => {
    if (args.some(a => a.includes('isInMergeQueue'))) return JSON.stringify({ data: { repository: { pullRequest: { isInMergeQueue: false, headRefOid: head } } } });
    if (args.some(a => a.includes('timelineItems'))) return JSON.stringify({ data: { repository: { pullRequest: { timelineItems: {
      nodes: [{ __typename: 'RemovedFromMergeQueueEvent', reason: 'failed_checks', createdAt: '2026-11-20T11:00:00Z',
        beforeCommit: { oid: merged, parents: { nodes: [{ oid: 'c'.repeat(40) }, { oid: head }] } } }], pageInfo: { hasPreviousPage: false },
    } } } } });
    if (args.includes('mergeStateStatus,headRefOid')) return JSON.stringify({ headRefOid: head, mergeStateStatus: 'CLEAN' });
    const endpoint = args[1]; reads.push(endpoint);
    if (endpoint.includes('/check-runs?')) return JSON.stringify({ total_count: 1, check_runs: [{ id: 21, name: 'build-linux', status: 'completed', conclusion: 'failure', output: { title: 'Runner disconnected', summary: '' } }] });
    if (endpoint.includes('/actions/workflows/ci.yml/runs?')) return JSON.stringify({ total_count: endpoint.includes('created=<') ? 0 : 1,
      workflow_runs: endpoint.includes('created=<') ? [] : [{ id: 103, head_sha: head, head_branch: 'main', event: 'push', path: '.github/workflows/ci.yml',
        status: 'completed', conclusion, created_at: '2026-11-20T11:30:00Z', updated_at: '2026-11-20T11:35:00Z' }] });
    throw Error(`Unexpected fixture IO: ${args.join(' ')}`);
  };
  const result = mqSameHeadGuard({ repo: 'fixture/repo', pr: 1, head, exec, now, quarantine: { readList: null } });
  expect(reads.some(p => p.includes('branch=main&event=push'))).toBe(true);
  return result;
}

it('control: the real drain evidence reader accepts a fresh successful push', () => {
  expect(evidence('success').hold).toBe(false);
});
it('reused push producer emits no main-green evidence to the unmodified drain', () => {
  // All existing required jobs pass on reuse. The extra, non-required producer must
  // prevent the overall workflow conclusion from succeeding, without continue-on-error.
  const marker = jobs['main-execution'];
  expect(marker?.['continue-on-error']).not.toBe(true);
  expect(marker?.steps[0]['continue-on-error']).not.toBe(true);
  const status = marker ? spawnSync('bash', ['-c', marker.steps[0].run], { encoding: 'utf8' }).status : 0;
  const conclusion = status === 0 || marker?.['continue-on-error'] === true ? 'success' : 'failure';
  const result = evidence(conclusion);
  expect(result.hold).toBe(true);
  expect(result.reason).toContain('main CI is not green');
  expect(result.mainRunId).toBe(103);
});
it('the execution marker is non-required and applies only to proven reused main pushes', () => {
  const marker = jobs['main-execution'];
  expect(marker).toBeDefined();
  const expr = marker.if.replace(/\$\{\{|\}\}/g, '');
  for (const event of ['push', 'pull_request', 'merge_group', 'schedule', 'workflow_dispatch']) {
    for (const skip of ['true', 'false', '', undefined]) {
      const run = Function('github', 'needs', `return (${expr})`)({ event_name: event, ref: 'refs/heads/main' }, { changes: { result: 'success', outputs: { skip } } });
      expect(run).toBe(event === 'push' && skip === 'true');
    }
  }
  for (const name of ['test', 'smoke', 'daemon-soak']) expect([jobs[name].needs].flat()).not.toContain('main-execution');
});
