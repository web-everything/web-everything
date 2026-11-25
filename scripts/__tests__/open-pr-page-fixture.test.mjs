import { it, expect, vi } from 'vitest';
import { openPrPageFixture } from './fixtures/open-pr-page-fixture.mjs';
import { buildOpenPrPageQuery, listOpenPrsPagedHydratedCompleteAsync } from '../lib/pr-list-paged.mjs';

const repo = 'fixture/repo';
const pr = { number: 42, headRefOid: 'a'.repeat(40), baseRefOid: 'b'.repeat(40), baseRefName: 'main',
  updatedAt: '2026-10-09T00:00:00Z', body: 'Fixture summary', files: [{ path: 'README.md' }],
  labels: [{ name: 'ready-to-merge' }, { name: 'review:accepted' }] };
const paging = { pageSize: 20, pageRetries: 0, heavyBackstopSeconds: 3600, heavySettleSeconds: 5 };
const query = buildOpenPrPageQuery({ repo, pageSize: 20 });
const options = {
  repo, paging, heavyFields: ['body', 'files'], delta: { isCandidate: () => true },
  exec: () => JSON.stringify(openPrPageFixture([pr], query)),
};

it('the shared CLI page carries the same complete identity and labels as the pinned PR view', async () => {
  const execAsync = vi.fn(async () => ({ stdout: JSON.stringify(pr) }));
  const result = await listOpenPrsPagedHydratedCompleteAsync({ ...options, execAsync });
  expect(result.rows).toMatchObject([{ number: 42, baseRefOid: pr.baseRefOid, updatedAt: pr.updatedAt,
    headRefOid: pr.headRefOid, labels: pr.labels, labelsComplete: true, body: pr.body, files: pr.files }]);
  expect(result.stats).toMatchObject({ fetched: 1, reused: 0, candidates: 1 });
  expect(execAsync).toHaveBeenCalledWith('gh', expect.arrayContaining([
    '--json', 'number,headRefOid,baseRefOid,baseRefName,updatedAt,body,files',
  ]), expect.any(Object));
});

it('empty fixture labels are complete and pagination preserves the server count', () => {
  const page = openPrPageFixture([pr, { ...pr, number: 43, labels: [] }],
    buildOpenPrPageQuery({ repo, pageSize: 1, after: '1' })).data.repository.pullRequests;
  expect(page).toMatchObject({ totalCount: 2, pageInfo: { hasNextPage: false },
    nodes: [{ number: 43, baseRefOid: pr.baseRefOid, labels: { totalCount: 0, nodes: [] } }] });
});

it('the shared fixture preserves missing base evidence so delta defers only that row', async () => {
  const incomplete = { ...pr };
  delete incomplete.baseRefOid;
  const result = await listOpenPrsPagedHydratedCompleteAsync({ ...options,
    exec: () => JSON.stringify(openPrPageFixture([incomplete], query)),
    execAsync: async () => ({ stdout: JSON.stringify(incomplete) }),
  });
  expect(result.rows).toMatchObject([{number:42,heavyReadError:expect.stringContaining('row-invalid'),rowsComplete:false}]);
  expect(result.store.size).toBe(0);
});

it('a base moved between the shared page and pinned view remains refused', async () => {
  const result = await listOpenPrsPagedHydratedCompleteAsync({ ...options,
    execAsync: async () => ({ stdout: JSON.stringify({ ...pr, baseRefOid: 'c'.repeat(40) }) }),
  });
  expect(result.rows).toMatchObject([{number:42,heavyReadError:expect.stringContaining('moved'),rowsComplete:false}]);
  expect(result.store.size).toBe(0);
});
