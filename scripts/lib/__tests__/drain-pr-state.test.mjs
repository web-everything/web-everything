// @vitest-environment node
import { it, expect, vi } from 'vitest';
import { resolveDrainPrState, readDrainPrStateBatch, batchedDrainPr } from '../drain-pr-state.mjs';

const pr = { number: 7, headRefOid: 'head', updatedAt: 'now', body: 'body',
  files: { pageInfo: { hasNextPage: false }, nodes: [{ path: 'a', additions: 1, deletions: 0 }] },
  commits: { pageInfo: { hasNextPage: false }, nodes: [{ commit: { oid: 'head', messageBody: '', messageHeadline: 'subject',
    authoredDate: 'then', committedDate: 'now', authors: { pageInfo: { hasNextPage: false },
      nodes: [{ name: 'Author', email: 'a@example.test', user: { id: 'id', login: 'author' } }, { name: 'Other', email: 'b@example.test', user: null }] } } }] } };
const page = (nodes, pageInfo = { hasNextPage: false, endCursor: null }) => ({ data: { r0: { pullRequests: { nodes, pageInfo } } } });
const ok = body => ({ stdout: JSON.stringify(body) });
const repoOf = call => call[2].env.GH_REPO;

it('reads each repository in its own query under its own owner, mapping gh view fields', async () => {
  const commitsOver = { ...pr, number: 10, commits: { ...pr.commits, pageInfo: { hasNextPage: true } } };
  const authorsOver = { ...pr, number: 11, commits: { ...pr.commits, nodes: [{ commit: { ...pr.commits.nodes[0].commit,
    authors: { ...pr.commits.nodes[0].commit.authors, pageInfo: { hasNextPage: true } } } }] } };
  const exec = vi.fn(async (_f, _a, o) => ok(o.env.GH_REPO === 'owner/one'
    ? page([pr, { ...pr, number: 8, files: { ...pr.files, pageInfo: { hasNextPage: true } } }, commitsOver, authorsOver, { number: 12 }]) : page([])));
  const reports = [];
  const batch = await readDrainPrStateBatch({ repos: ['owner/one', 'other/two'], exec, env: {}, report: r => reports.push(r) });
  expect(exec).toHaveBeenCalledTimes(2);
  expect(exec.mock.calls.map(repoOf).sort()).toEqual(['other/two', 'owner/one']);
  for (const call of exec.mock.calls) {
    const [owner, name] = repoOf(call).split('/');
    expect(call[1][3]).toContain(`repository(owner:"${owner}",name:"${name}")`);
    expect(call[1][3]).not.toContain('r1:');
  }
  expect(batchedDrainPr(batch, 'owner/one', pr)).toEqual({ number: 7, headRefOid: 'head', updatedAt: 'now', body: 'body',
    files: pr.files.nodes, commits: [{ oid: 'head', messageBody: '', messageHeadline: 'subject', authoredDate: 'then', committedDate: 'now',
      authors: [{ name: 'Author', email: 'a@example.test', id: 'id', login: 'author' }, { name: 'Other', email: 'b@example.test', id: '', login: '' }] }] });
  // Over the caps, absent, or a changed identity: never served from the batch.
  for (const row of [{ ...pr, number: 8 }, { ...pr, number: 9 }, { ...pr, number: 10 }, { ...pr, number: 11 }, { ...pr, number: 12 }, { ...pr, headRefOid: 'changed' }, { ...pr, updatedAt: 'later' }])
    expect(batchedDrainPr(batch, 'owner/one', row)).toBeNull();
  expect(batch.get('other/two')).toEqual([]);
  expect(reports.find(r => r.repo === 'owner/one')).toMatchObject({ ok: true, rows: 1, pages: 1, overflow: 4 });
});

it('sizes the query from pageSize and commitsPerPr', async () => {
  const exec = vi.fn(async () => ok(page([])));
  await readDrainPrStateBatch({ repos: ['owner/one'], exec, env: {}, pageSize: 25, commitsPerPr: 30 });
  expect(exec.mock.calls[0][1][3]).toContain('pullRequests(states:OPEN,first:25)');
  expect(exec.mock.calls[0][1][3]).toContain('commits(first:30)');
});

it('drops only the failing repository: errors, partial data, a gh failure or a broken page keep it on per-PR reads', async () => {
  const failures = [
    async () => ok({ ...page([pr]), errors: [{ type: 'NOT_FOUND', message: 'partial failure' }] }),
    async () => { throw Object.assign(Error('Command failed: gh api graphql -f query=…'), { stdout: JSON.stringify({ errors: [{ type: 'NOT_FOUND' }] }) }); },
    async () => { throw Error('offline'); },
    async () => ok({ data: { r0: null } }),
    async () => ({ stdout: 'not json' }),
    async () => ok(page([pr], { hasNextPage: true, endCursor: null })),
  ];
  for (const fail of failures) {
    const reports = [];
    const exec = vi.fn((f, a, o) => (o.env.GH_REPO === 'bad/repo' ? fail() : Promise.resolve(ok(page([pr])))));
    const batch = await readDrainPrStateBatch({ repos: ['good/repo', 'bad/repo'], exec, env: {}, report: r => reports.push(r) });
    expect(batch.has('bad/repo')).toBe(false);
    expect(batchedDrainPr(batch, 'bad/repo', pr)).toBeNull();
    expect(batchedDrainPr(batch, 'good/repo', pr)).not.toBeNull();
    const bad = reports.find(r => r.repo === 'bad/repo');
    expect(bad.ok).toBe(false);
    expect(bad.error).not.toContain('query=');
  }
});

it('pages a repository, failing the whole repository when a later page fails', async () => {
  const exec = vi.fn()
    .mockResolvedValueOnce(ok(page([pr], { hasNextPage: true, endCursor: 'next' })))
    .mockResolvedValueOnce(ok(page([{ ...pr, number: 8 }])));
  expect((await readDrainPrStateBatch({ repos: ['owner/one'], exec, env: {} })).get('owner/one')).toHaveLength(2);
  expect(exec.mock.calls[1][1][3]).toContain('after:"next"');
  const failing = vi.fn()
    .mockResolvedValueOnce(ok(page([pr], { hasNextPage: true, endCursor: 'next' })))
    .mockRejectedValueOnce(Error('rate limited'));
  expect((await readDrainPrStateBatch({ repos: ['owner/one'], exec: failing, env: {} })).has('owner/one')).toBe(false);
  const looping = vi.fn().mockResolvedValue(ok(page([pr], { hasNextPage: true, endCursor: 'same' })));
  expect((await readDrainPrStateBatch({ repos: ['owner/one'], exec: looping, env: {} })).has('owner/one')).toBe(false);
  expect(looping).toHaveBeenCalledTimes(2);
  const exec2 = vi.fn(async () => ok(page([pr])));
  expect((await readDrainPrStateBatch({ repos: ['not a slug'], exec: exec2, env: {} })).size).toBe(0);
  expect(exec2).not.toHaveBeenCalled();
});

it('resolves the cascade with logged sources', () => {
  const log = vi.fn();
  const policy = resolveDrainPrState({ file: { drain: { prState: { batched: false } } }, platform: { batched: true },
    env: { WE_DRAIN_PR_STATE_BATCHED: 'on', WE_POLICY_CASCADE_LOG: '1' }, log });
  expect(policy.value.batched).toBe(true);
  expect(policy.sources.batched).toBe('env');
  expect(log).toHaveBeenCalledWith(expect.stringContaining('batched=true (env)'));
  const std = resolveDrainPrState({ file: {}, platform: {}, env: {} });
  expect(std.value).toMatchObject({ batched: true, pageSize: 40, commitsPerPr: 50 });
  expect(resolveDrainPrState({ file: { drain: { prState: { batched: false } } }, platform: {}, env: {} }).sources.batched).toBe('tool');
  const sized = resolveDrainPrState({ file: {}, platform: {}, env: { WE_DRAIN_PR_STATE_PAGE_SIZE: '20', WE_DRAIN_PR_STATE_COMMITS: '500' } });
  expect(sized.value.pageSize).toBe(20);
  expect(sized.sources.pageSize).toBe('env');
  expect(sized.value.commitsPerPr).toBe(50); // out of range → ignored, standard kept
});
