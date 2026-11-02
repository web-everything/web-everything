import { it, expect } from 'vitest';
import { createEventLog, createMemoryStorage, handleRequest } from '../core.mjs';

const T = 1_000_000;
function fixture(count) {
  const storage = createMemoryStorage(), log = createEventLog(storage);
  log.bootstrap({ repo: 'o/r', importId: 'seed', baseCursor: 0, status: 'complete', prs: [] }, T);
  for (let n = count - 1; n >= 0; n -= 1) storage.putProjection('prs', JSON.stringify(['o/r', n]), {
    repo: 'o/r', number: n, seq: n, state: n % 2 ? 'closed' : 'open', fields: { state: 1 }, updatedAt: T,
  });
  const read = async (query = '') => (await handleRequest(new Request(`https://test/prs${query}`, {
    headers: { authorization: 'Bearer read' },
  }), { PR_EVENTS_READ_TOKEN: 'read' }, { getLog: () => log, now: () => T })).json();
  return { log, storage, read };
}

it('defaults to the first 200 rows in ascending sequence, including bootstrap sequence zero, without truncation', async () => {
  const { read } = fixture(501), body = await read();
  expect(body.prs.map((r) => r.seq)).toEqual(Array.from({ length: 200 }, (_, n) => n));
  expect(body).toMatchObject({ prsCursor: 199, prsMore: true, truncated: { rows: 0, repos: {}, malformed: 0 } });
  expect(body.repos['o/r'].coverage).toBe(true);
});

it('caps PR pages at 500, resumes after the row cursor, and terminates with a stable empty cursor', async () => {
  const { read } = fixture(502);
  const first = await read('?prsLimit=9999');
  expect(first.prs).toHaveLength(500);
  expect(first).toMatchObject({ prsCursor: 499, prsMore: true });
  const next = await read('?prsCursor=499&prsLimit=2');
  expect(next.prs.map((r) => r.seq)).toEqual([500, 501]);
  expect(next).toMatchObject({ prsCursor: 501, prsMore: false });
  expect(await read('?prsCursor=501')).toMatchObject({ prs: [], prsCursor: 501, prsMore: false });
});

it('decouples PR query parameters from event pagination and preserves the event envelope', async () => {
  const { log, read } = fixture(4);
  for (let n = 0; n < 3; n += 1) log.append({ repo: 'o/other', type: 'check_run', prs: [] }, T);
  const body = await read('?cursor=0&limit=1&prsCursor=1&prsLimit=1');
  expect(body).toMatchObject({ ...log.read(0, 1), stateCursor: 3, prsCursor: 2, prsMore: true });
  expect(body.prs.map((r) => r.number)).toEqual([2]);
});

it('uses the default first page for invalid PR pagination parameters', async () => {
  const { read } = fixture(3);
  expect(await read('?prsCursor=bad&prsLimit=bad')).toMatchObject({ prsCursor: 2, prsMore: false });
  expect((await read('?prsCursor=bad&prsLimit=bad')).prs).toHaveLength(3);
});

it('resumes within tied bootstrap sequences using a stable row key without skipping or duplicating rows', async () => {
  const { storage, read } = fixture(5);
  for (const { key, value } of storage.listProjection('prs', true)) storage.putProjection('prs', key, { ...value, seq: 0 });
  const seen = [];
  const a = await read('?prsLimit=2'); seen.push(...a.prs.map((r) => r.number));
  expect(a).toMatchObject({ prsCursor: 0, prsAfter: JSON.stringify(['o/r', 1]), prsMore: true });
  const resume = (page) => `?prsLimit=2&prsCursor=${page.prsCursor}&prsAfter=${encodeURIComponent(page.prsAfter)}`;
  const b = await read(resume(a)); seen.push(...b.prs.map((r) => r.number));
  expect(b).toMatchObject({ prsCursor: 0, prsAfter: JSON.stringify(['o/r', 3]), prsMore: true });
  const c = await read(resume(b)); seen.push(...c.prs.map((r) => r.number));
  expect(c).toMatchObject({ prsCursor: 0, prsAfter: JSON.stringify(['o/r', 4]), prsMore: false });
  expect(seen.sort()).toEqual([0, 1, 2, 3, 4]);
  expect((await read('?prsCursor=0&prsLimit=2')).prs).toEqual([]);
});

it.each(['broken', '[]', '["o/r","one"]'])('rejects an invalid composite cursor %s rather than restarting pagination', async (prsAfter) => {
  const { log } = fixture(3);
  const response = await handleRequest(new Request(`https://test/prs?prsCursor=0&prsAfter=${encodeURIComponent(prsAfter)}`, {
    headers: { authorization: 'Bearer read' },
  }), { PR_EVENTS_READ_TOKEN: 'read' }, { getLog: () => log, now: () => T });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: 'invalid PR row cursor' });
});
