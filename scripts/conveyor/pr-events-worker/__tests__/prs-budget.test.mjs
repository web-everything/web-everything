import { describe, it, expect } from 'vitest';
import * as core from '../core.mjs';

const T = 1_000_000;
const bytes = (value) => Buffer.byteLength(JSON.stringify(value));
function fixture(prsBudgetBytes) {
  const storage = core.createMemoryStorage();
  const log = core.createEventLog(storage, { prsBudgetBytes });
  for (const repo of ['o/a', 'o/b']) log.bootstrap({ repo, importId: 'seed', baseCursor: 0, status: 'complete', prs: [] }, T);
  const put = (number, state = 'open', repo = 'o/a', size = 1000, seq = number) => {
    storage.putProjection('prs', `${repo}-${number}`, { repo, number, state, seq, sha: `${repo}-${number}`, fields: { state: 1 } });
    storage.putProjection('checks', `${repo}-${number}`, { repo, prs: [number], type: 'check_run', seq, name: '界'.repeat(size) });
  };
  return { storage, log, put, read: () => log.readPrs(null, 10, T) };
}

describe('/prs response budget', () => {
  it.each([0, -1])('bounds the complete HTTP UTF-8 body including now at the exact boundary (%i bytes)', async (delta) => {
    const h = fixture(); h.put(1); h.put(2, 'closed');
    const request = (log) => core.handleRequest(new Request('https://test/prs', {
      headers: { authorization: 'Bearer read' },
    }), { PR_EVENTS_READ_TOKEN: 'read' }, { getLog: () => log, now: () => T });
    const full = await (await request(h.log)).text();
    const budget = Buffer.byteLength(full) + delta;
    const log = core.createEventLog(h.storage, { prsBudgetBytes: budget });
    const response = await request(log), text = await response.text();
    expect(response.status).toBe(200);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(budget);
    expect(JSON.parse(text)).toMatchObject({ now: T, truncated: { rows: delta === 0 ? 0 : 1 } });
    if (delta === 0) expect(Buffer.byteLength(text)).toBe(budget);
  });

  it.each(['events', 'bootstrap'])('rejects an envelope-only %s overflow with a bounded HTTP 503 response', async (source) => {
    const budget = 2000, h = fixture(budget);
    if (source === 'events') h.log.append({ repo: 'o/a', type: 'check_run', prs: [], name: 'x'.repeat(5000) }, T);
    else h.storage.putProjection('bootstrap', 'oversized', { repo: 'o/c', status: 'failed', detail: 'x'.repeat(5000) });
    // No PR rows can be removed to make this envelope fit.
    expect(h.storage.listProjection('prs')).toEqual([]);
    expect(() => h.log.readPrs(0, 10, T)).toThrow('PR snapshot envelope exceeds response budget');
    const response = await core.handleRequest(new Request('https://test/prs?cursor=0', {
      headers: { authorization: 'Bearer read' },
    }), { PR_EVENTS_READ_TOKEN: 'read' }, { getLog: () => h.log, now: () => T });
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toEqual({ error: 'PR snapshot envelope exceeds response budget' });
    expect(bytes(body)).toBeLessThanOrEqual(budget);
    if (source === 'events') expect(h.log.read(0, 10).events).toHaveLength(1);
  });

  it('defaults to 20 MiB and bounds a large snapshot including embedded checks and suites', () => {
    expect(core.PRS_RESPONSE_BUDGET_BYTES).toBe(20 * 1024 * 1024);
    const h = fixture();
    for (let n = 1; n <= 24; n += 1) h.put(n, 'closed', 'o/a', 350_000);
    h.storage.putProjection('checks', 'suite', { repo: 'o/a', prs: [1], type: 'check_suite', seq: 0, app: 'x'.repeat(1_000_000) });
    const body = h.read();
    expect(bytes(body)).toBeLessThanOrEqual(core.PRS_RESPONSE_BUDGET_BYTES);
    expect(body.prs.length).toBeGreaterThan(0);
    expect(body.truncated.rows).toBe(24 - body.prs.length);
    expect(body.prs[0].suites).toHaveLength(1);
  });

  it('keeps the ascending page prefix and preserves coverage for closed-only budget drops', () => {
    const h = fixture(8500);
    h.put(1, 'closed'); h.put(3, 'closed'); h.put(2);
    const body = h.read();
    expect(body.prs.map((p) => p.number)).toEqual([1, 2]);
    expect(body.truncated).toMatchObject({ rows: 1, repos: { 'o/a': 1 } });
    expect(body.repos['o/a'].coverage).toBe(true);
    expect(body.repos['o/b'].coverage).toBe(true);
    expect(bytes(body)).toBeLessThanOrEqual(8500);
  });

  it('fails closed only for a repo whose open row exceeds the budget and stops at that row', () => {
    const h = fixture(8500);
    h.put(1, 'open', 'o/b'); h.put(2, 'open', 'o/a', 5000); h.put(3, 'closed', 'o/b', 1);
    const body = h.read();
    expect(body.prs.map((p) => p.number)).toEqual([1]);
    expect(body.truncated).toMatchObject({ rows: 2, repos: { 'o/a': 1, 'o/b': 1 } });
    expect(body.repos['o/a'].coverage).toBe(false);
    expect(body.repos['o/b'].coverage).toBe(true);
    expect(bytes(body)).toBeLessThanOrEqual(8500);
  });

  it('counts envelope, UTF-8, separators and truncation metadata at the exact boundary', () => {
    const h = fixture();
    h.put(1); h.put(2, 'closed');
    const budget = bytes(h.read()) - 1;
    const body = core.createEventLog(h.storage, { prsBudgetBytes: budget }).readPrs(null, 10, T);
    expect(bytes(body)).toBeLessThanOrEqual(budget);
    expect(body.prs).toHaveLength(1);
    expect(body.truncated.rows).toBe(1);
  });

  it('returns an empty bounded snapshot with explicit incomplete coverage for a single oversized open PR', () => {
    const h = fixture(2000); h.put(1);
    const body = h.read();
    expect(body.prs).toEqual([]);
    expect(body.truncated).toMatchObject({ rows: 1, repos: { 'o/a': 1 } });
    expect(body.repos['o/a'].coverage).toBe(false);
    expect(body.repos['o/b'].coverage).toBe(true);
    expect(bytes(body)).toBeLessThanOrEqual(2000);
  });

  it('reports zero drops and keeps the existing envelope and projection fields unchanged', () => {
    const h = fixture(); h.put(1);
    const body = h.read();
    expect(body.truncated).toMatchObject({ rows: 0, repos: {} });
    expect(body).toMatchObject({ ...h.log.read(null, 10), stateCursor: 0, coverage: { partial: true, bootstrap: expect.any(Array) } });
    expect(body.prs[0]).toMatchObject({ number: 1, sha: 'o/a-1', state: 'open', checks: [{ type: 'check_run' }], suites: [] });
    expect(body.prs[0]).not.toHaveProperty('fields');
  });
});

describe('/prs legacy storage', () => {
  it('skips malformed PR and check rows, counts them and isolates lost coverage', () => {
    const h = fixture(); h.put(1, 'open', 'o/b');
    const bad = [null, 'legacy', [], { repo: 'o/a' }, { repo: 'o/a', number: 1.5 }, { repo: 42, number: 1 }];
    bad.forEach((row, n) => h.storage.putProjection('prs', `bad-${n}`, row));
    [null, 'legacy', [], { repo: 'o/a', prs: {} }].forEach((row, n) => h.storage.putProjection('checks', `bad-${n}`, row));
    const body = h.read();
    expect(body.prs.map((p) => p.number)).toEqual([1]);
    expect(body.truncated).toMatchObject({ rows: 0, repos: {}, malformed: 10 });
    expect(body.repos['o/a'].coverage).toBe(false);
    expect(body.repos['o/b'].coverage).toBe(true);
  });

  it.each([null, '', '{broken', 'null', '[]', '42', '"legacy"'])('tolerates invalid coverage metadata %j', (value) => {
    const h = fixture(); h.storage.setMeta('coverage', value);
    expect(h.read().coverage).toEqual({ bootstrap: h.storage.listProjection('bootstrap') });
  });
});
