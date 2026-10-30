// @vitest-environment node
import { it, expect, vi } from 'vitest';
import { resolveDrainPrState, readDrainPrStateBatch, batchedDrainPr } from '../drain-pr-state.mjs';

it('batches repositories, maps gh view fields, and leaves missing, changed, capped or failed reads to gh view', async () => {
  const pr = { number: 7, headRefOid: 'head', updatedAt: 'now', body: 'body',
    files: { pageInfo: { hasNextPage: false }, nodes: [{ path: 'a', additions: 1, deletions: 0 }] },
    commits: { pageInfo: { hasNextPage: false }, nodes: [{ commit: { oid: 'head', messageBody: '', messageHeadline: 'subject',
      authoredDate: 'then', committedDate: 'now', authors: { pageInfo: { hasNextPage: false },
        nodes: [{ name: 'Author', email: 'a@example.test', user: { id: 'id', login: 'author' } }, { name: 'Other', email: 'b@example.test', user: null }] } } }] } };
  const page = nodes => ({ pullRequests: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } });
  const response = { data: { r0: page([pr, { ...pr, number: 8, files: { ...pr.files, pageInfo: { hasNextPage: true } } }]), r1: page([]) } };
  const exec = vi.fn(async () => ({ stdout: JSON.stringify(response) }));
  const batch = await readDrainPrStateBatch({ repos: ['owner/one', 'owner/two'], exec });
  expect(exec).toHaveBeenCalledTimes(1);
  expect(exec.mock.calls[0][1][3]).toContain('r1:repository');
  expect(batchedDrainPr(batch, 'owner/one', pr)).toEqual({ number: 7, headRefOid: 'head', updatedAt: 'now', body: 'body',
    files: pr.files.nodes, commits: [{ oid: 'head', messageBody: '', messageHeadline: 'subject', authoredDate: 'then', committedDate: 'now',
      authors: [{ name: 'Author', email: 'a@example.test', id: 'id', login: 'author' }, { name: 'Other', email: 'b@example.test', id: '', login: '' }] }] });
  for (const row of [{ ...pr, number: 8 }, { ...pr, number: 9 }, { ...pr, headRefOid: 'changed' }, { ...pr, updatedAt: 'later' }])
    expect(batchedDrainPr(batch, 'owner/one', row)).toBeNull();
  response.errors = [{ message: 'partial failure' }];
  expect(await readDrainPrStateBatch({ repos: ['owner/one'], exec })).toEqual(new Map());
  exec.mockRejectedValue(Error('offline'));
  expect(await readDrainPrStateBatch({ repos: ['owner/one'], exec })).toEqual(new Map());
  exec.mockReset();
  exec.mockResolvedValueOnce({ stdout: JSON.stringify({ data: { r0: { pullRequests: { nodes: [pr], pageInfo: { hasNextPage: true, endCursor: 'next' } } } } }) })
    .mockResolvedValueOnce({ stdout: JSON.stringify({ data: { r0: page([]) } }) });
  expect((await readDrainPrStateBatch({ repos: ['owner/one'], exec })).get('owner/one')).toHaveLength(1);
  expect(exec.mock.calls[1][1][3]).toContain('after:"next"');
  const log = vi.fn();
  const policy = resolveDrainPrState({ file: { drain: { prState: { batched: false } } }, platform: { batched: true },
    env: { WE_DRAIN_PR_STATE_BATCHED: 'on', WE_POLICY_CASCADE_LOG: '1' }, log });
  expect(policy.value.batched).toBe(true);
  expect(policy.sources.batched).toBe('env');
  expect(log).toHaveBeenCalledWith(expect.stringContaining('batched=true (env)'));
  expect(resolveDrainPrState({ file: {}, platform: {}, env: {} }).value.batched).toBe(true);
  expect(resolveDrainPrState({ file: { drain: { prState: { batched: false } } }, platform: {}, env: {} }).sources.batched).toBe('tool');
});
