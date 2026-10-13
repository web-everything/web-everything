/**
 * @file scripts/lib/__tests__/pr-list-paged.test.mjs
 * @description Hermetic paging, gh-shape mapping, heavy-field freshness and policy cascade probes.
 */
import { describe, it, expect, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildOpenPrPageQuery, mapGraphqlPr, parseOpenPrPage, isTransientGhFailure, heavyIsFresh,
  listOpenPrsLightPaged, listOpenPrsPagedHydrated, hydrateHeavyFields, resolvePrListPaging, PrListUnreadableError,
  HEAVY_FIELDS, PAGED_LIGHT_FIELDS, PR_LIST_PAGING_DEFAULTS, PR_LIST_PAGE_SIZE_ENV,
} from '../pr-list-paged.mjs';

const repo = 'owner/name';
const node = (number, extra = {}) => ({ number, title: `PR ${number}`, url: `https://example.com/${number}`,
  isDraft: false, createdAt: '2026-10-12T00:00:00Z', updatedAt: '2026-10-13T00:00:00Z',
  headRefName: `branch-${number}`, headRefOid: `head-${number}`, baseRefName: 'main',
  isCrossRepository: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: null, ...extra });
const page = (nodes, hasNextPage = false, endCursor = null, totalCount = 45) => JSON.stringify({
  data: { repository: { pullRequests: { nodes, pageInfo: { hasNextPage, endCursor }, totalCount } } },
});
const failure = (stderr) => Object.assign(new Error('gh failed'), { stderr: Buffer.from(stderr) });
const timeout = 'HTTP 504: 504 Gateway Timeout (https://api.github.com/graphql)';
const heavy = { comments: [{ body: 'hello' }], body: 'description', files: [{ path: 'a.js' }] };
const row = number => mapGraphqlPr(node(number));
const cached = (r, extra = {}) => ({ updatedAt: r.updatedAt, headRefOid: r.headRefOid,
  fetchedAtMs: 9500, ...heavy, ...extra });
const opts = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
  timeout: 60_000, killSignal: 'SIGKILL' };

describe('query and gh row shape', () => {
  it('builds first and subsequent pages, quotes cursors and rejects invalid repos', () => {
    const q = buildOpenPrPageQuery({ repo, pageSize: 20 });
    expect(q).toContain('repository(owner:"owner",name:"name")');
    expect(q).toContain('states:OPEN,first:20,orderBy:');
    expect(q).not.toContain('after:');
    expect([...q].filter(c => c === '{')).toHaveLength([...q].filter(c => c === '}').length);
    const after = 'cursor"\\\n';
    expect(buildOpenPrPageQuery({ repo, pageSize: 20, after })).toContain(`after:${JSON.stringify(after)}`);
    for (const bad of ['owner', 'owner/name/other', 'owner/"name', '', null]) {
      expect(() => buildOpenPrPageQuery({ repo: bad, pageSize: 20 })).toThrow(TypeError);
    }
  });
  it('maps both check kinds exactly, including nulls and empty connections', () => {
    const check = { __typename: 'CheckRun', name: 'test', status: 'IN_PROGRESS', completedAt: null,
      conclusion: null, startedAt: null, detailsUrl: 'https://example.com/check' };
    const status = { __typename: 'StatusContext', context: 'ci', createdAt: 'today', state: 'PENDING', targetUrl: null };
    const n = node(1, { labels: { nodes: [{ id: 'id', name: 'ready', description: '', color: 'abc123' }] },
      commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [check, status] } } } }] } });
    expect(mapGraphqlPr(n)).toEqual({ ...node(1), reviewDecision: '', labels: n.labels.nodes, statusCheckRollup: [
      { __typename: 'CheckRun', completedAt: '0001-01-01T00:00:00Z', conclusion: '', detailsUrl: check.detailsUrl,
        name: 'test', startedAt: '0001-01-01T00:00:00Z', status: 'IN_PROGRESS', workflowName: '' },
      { __typename: 'StatusContext', context: 'ci', startedAt: 'today', state: 'PENDING', targetUrl: '' },
    ] });
    expect(Object.keys(row(1))).toEqual(PAGED_LIGHT_FIELDS);
    expect(row(1)).toMatchObject({ labels: [], statusCheckRollup: [], reviewDecision: '' });
    check.checkSuite = { workflowRun: { workflow: { name: 'build' } } };
    expect(mapGraphqlPr(n).statusCheckRollup[0].workflowName).toBe('build');
    expect(Object.isFrozen(HEAVY_FIELDS)).toBe(true);
    expect(Object.isFrozen(PAGED_LIGHT_FIELDS)).toBe(true);
  });
  it('rejects GraphQL errors, partial responses and missing data', () => {
    expect(parseOpenPrPage(page([node(1)]))).toEqual({ rows: [row(1)], hasNextPage: false, endCursor: null, totalCount: 45 });
    for (const text of ['{}', '{"data":null}', page([]).replace('"nodes":[]', '"nodes":null'),
      JSON.stringify({ errors: [{ message: 'GraphQL: Something went wrong while executing your query' }], data: {} })]) {
      expect(() => parseOpenPrPage(text)).toThrow();
    }
  });
  it('uses shared transient patterns', () => {
    for (const text of [timeout, 'HTTP 502', 'unexpected end of JSON input', "invalid character '<' looking for beginning of value"]) {
      expect(isTransientGhFailure(text)).toBe(true);
    }
    expect(isTransientGhFailure('HTTP 401')).toBe(false);
  });
});

describe('light paging', () => {
  it('reads 45 ordered rows in three light requests with byte and page accounting', () => {
    const nodes = Array.from({ length: 45 }, (_, i) => node(45 - i));
    const texts = [page(nodes.slice(0, 20), true, 'a'), page(nodes.slice(20, 40), true, 'b'), page(nodes.slice(40))];
    const exec = vi.fn();
    for (const text of texts) exec.mockReturnValueOnce(text);
    const result = listOpenPrsLightPaged({ repo, exec, pageSize: 20 });
    expect(result).toMatchObject({ rows: nodes.map(mapGraphqlPr), pages: 3, truncated: false, totalCount: 45,
      bytes: texts.reduce((n, text) => n + Buffer.byteLength(text), 0) });
    expect(result.ms).toBeGreaterThanOrEqual(0);
    expect(exec).toHaveBeenCalledTimes(3);
    for (const [file, argv, options] of exec.mock.calls) {
      expect(file).toBe('gh');
      expect(argv.slice(0, 3)).toEqual(['api', 'graphql', '-f']);
      expect(argv).toHaveLength(4);
      expect(argv[3]).toMatch(/^query=query\{/);
      expect(argv[3]).not.toMatch(/comments|body|files\(/);
      expect(options).toEqual(opts);
    }
    expect(exec.mock.calls[1][1][3]).toContain('after:"a"');
  });
  it('retries a transient second page once and never publishes a failed partial list', () => {
    const cause = failure(`${timeout}\nextra detail`);
    const exec = vi.fn().mockReturnValueOnce(page([node(1)], true, 'a'))
      .mockImplementationOnce(() => { throw cause; }).mockReturnValueOnce(page([node(2)]));
    expect(listOpenPrsLightPaged({ repo, exec, pageSize: 20 }).rows.map(r => r.number)).toEqual([1, 2]);
    expect(exec).toHaveBeenCalledTimes(3);
    const always = vi.fn().mockReturnValueOnce(page([node(1)], true, 'a')).mockImplementation(() => { throw cause; });
    let error;
    try { listOpenPrsLightPaged({ repo, exec: always, pageSize: 20 }); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(PrListUnreadableError);
    expect(error).toMatchObject({ code: 'pr-list-unreadable', unreadable: true, repo, stage: 'page', page: 2, cause });
    expect(String(error.stderr)).toContain('HTTP 504');
    expect(error.message).toBe(`open-PR list unreadable for ${repo}: page page 2 failed: ${timeout}`);
    expect(always).toHaveBeenCalledTimes(3);
  });
  it('does not retry a non-transient failure', () => {
    const exec = vi.fn(() => { throw failure('HTTP 401'); });
    expect(() => listOpenPrsLightPaged({ repo, exec, pageSize: 20 })).toThrow(PrListUnreadableError);
    expect(exec).toHaveBeenCalledTimes(1);
  });
  it('retries transient parse failures and rejects non-transient malformed pages', () => {
    const exec = vi.fn().mockReturnValueOnce('').mockReturnValueOnce(page([node(1)]));
    expect(listOpenPrsLightPaged({ repo, exec, pageSize: 20 }).rows).toEqual([row(1)]);
    const missing = vi.fn(() => '{}');
    expect(() => listOpenPrsLightPaged({ repo, exec: missing, pageSize: 20 })).toThrow(PrListUnreadableError);
    expect(missing).toHaveBeenCalledTimes(1);
  });
  it('stops at maxRows with truncation and preserves exec overrides', () => {
    const exec = vi.fn(() => page([node(1), node(2)], true, 'a'));
    expect(listOpenPrsLightPaged({ repo, exec, pageSize: 2, maxRows: 2, execOpts: { timeout: 123 } }))
      .toMatchObject({ truncated: true, pages: 1 });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0][2]).toEqual({ ...opts, timeout: 123 });
  });
  it('returns a parsed deferral immediately, including after a successful page', () => {
    const deferred = { outcome: 'deferred-low-budget', message: 'later' };
    const exec = vi.fn().mockReturnValueOnce(page([node(1)], true, 'a'))
      .mockReturnValueOnce(Buffer.from(JSON.stringify(deferred)));
    expect(listOpenPrsLightPaged({ repo, exec, pageSize: 20 })).toEqual({ deferred });
    expect(exec).toHaveBeenCalledTimes(2);
  });
});

describe('heavy hydration', () => {
  it('requires both identity stamps and strictly younger age', () => {
    const r = row(1);
    expect(heavyIsFresh(cached(r), r, { nowMs: 10000, maxAgeMs: 1000 })).toBe(true);
    for (const c of [null, cached(r, { updatedAt: 'changed' }), cached(r, { headRefOid: 'changed' }),
      cached(r, { fetchedAtMs: 9000 })]) {
      expect(heavyIsFresh(c, r, { nowMs: 10000, maxAgeMs: 1000 })).toBeFalsy();
    }
  });
  it('reuses fresh fields, prunes old numbers and creates new rows without mutating inputs', () => {
    const r = Object.freeze(row(1));
    const cache = { 1: cached(r), 2: cached(row(2)) };
    const exec = vi.fn();
    const result = hydrateHeavyFields({ repo, rows: [r], exec, cache, nowMs: 10000, maxAgeMs: 1000 });
    expect(exec).not.toHaveBeenCalled();
    expect(result).toEqual({ rows: [{ ...r, ...heavy }], cache: { 1: cache[1] }, fetched: 0, reused: 1 });
    expect(result.rows[0]).not.toBe(r);
    expect(r).not.toHaveProperty('body');
  });
  it('fetches changed, old or missing entries with exact view argv and options', () => {
    const rows = [row(1), row(2), row(3), row(4)];
    const before = structuredClone(rows);
    const cache = { 1: cached(rows[0], { updatedAt: 'old' }), 2: cached(rows[1], { fetchedAtMs: 8000 }),
      4: cached(rows[3], { headRefOid: 'old' }) };
    const exec = vi.fn(() => JSON.stringify(heavy));
    const result = hydrateHeavyFields({ repo, rows, exec, cache, nowMs: 10000, maxAgeMs: 1000 });
    expect(result).toMatchObject({ fetched: 4, reused: 0, rows: rows.map(r => ({ ...r, ...heavy })) });
    for (const [i, call] of exec.mock.calls.entries()) {
      expect(call).toEqual(['gh', ['pr', 'view', String(i + 1), '--repo', repo, '--json', 'comments,body,files'], opts]);
      expect(result.cache[i + 1]).toEqual(cached(rows[i], { fetchedAtMs: 10000 }));
    }
    expect(rows).toEqual(before);
  });
  it('wraps view execution, parse and deferred failures with PR identity', () => {
    for (const exec of [() => { throw failure(timeout); }, () => '{',
      () => JSON.stringify({ outcome: 'deferred-low-budget' })]) {
      let error;
      try { hydrateHeavyFields({ repo, rows: [row(5)], exec, nowMs: 10000, maxAgeMs: 1000 }); } catch (e) { error = e; }
      expect(error).toBeInstanceOf(PrListUnreadableError);
      expect(error).toMatchObject({ stage: 'hydrate', number: 5, repo, unreadable: true });
      expect(error.message).toContain('hydrate PR #5 failed:');
    }
  });
});

describe('paging policy', () => {
  const env = { WE_PLATFORM_PREFERENCES_FILE: join(tmpdir(), `pr-list-paging-missing-${process.pid}.json`) };
  it('resolves defaults, tool and env with per-leaf sources', () => {
    expect(resolvePrListPaging({ file: {}, env })).toEqual({ ...PR_LIST_PAGING_DEFAULTS,
      source: { pageSize: 'standard', pageRetries: 'standard', heavyMaxAgeSeconds: 'standard' } });
    const file = { prListPaging: { pageSize: 30, pageRetries: 2, heavyMaxAgeSeconds: 60 } };
    expect(resolvePrListPaging({ file, env })).toEqual({ pageSize: 30, pageRetries: 2, heavyMaxAgeSeconds: 60,
      source: { pageSize: 'tool', pageRetries: 'tool', heavyMaxAgeSeconds: 'tool' } });
    expect(resolvePrListPaging({ file, env: { ...env, [PR_LIST_PAGE_SIZE_ENV]: '7' } }))
      .toMatchObject({ pageSize: 7, source: { pageSize: 'env' } });
  });
  it.each(['abc', '0', '500', '7abc', '1.5', ''])('ignores invalid env %s', value => {
    expect(resolvePrListPaging({ file: {}, env: { ...env, WE_PR_LIST_PAGE_SIZE: value } }))
      .toMatchObject({ pageSize: 20, source: { pageSize: 'standard' } });
  });
  it('ignores invalid tool leaves and accepts boundary values', () => {
    expect(resolvePrListPaging({ file: { prListPaging: { pageSize: 101, pageRetries: 4, heavyMaxAgeSeconds: -1 } }, env }))
      .toMatchObject(PR_LIST_PAGING_DEFAULTS);
    expect(resolvePrListPaging({ file: { prListPaging: { pageSize: 100, pageRetries: 0, heavyMaxAgeSeconds: 86400 } }, env }))
      .toMatchObject({ pageSize: 100, pageRetries: 0, heavyMaxAgeSeconds: 86400 });
  });
});


describe('paged hydrated listing', () => {
  const paging = { pageSize: 1, pageRetries: 1, heavyMaxAgeSeconds: 1 };
  const list = (exec, extra = {}) => listOpenPrsPagedHydrated({ repo, exec, paging,
    heavyFields: ['body', 'files'], nowMs: 10000, ...extra });

  it('throws on a repeatedly failing second page without hydrating partial rows', () => {
    const exec = vi.fn().mockReturnValueOnce(page([node(1)], true, 'a'))
      .mockImplementation(() => { throw failure(timeout); });
    let error;
    try { list(exec); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(PrListUnreadableError);
    expect(error).toMatchObject({ unreadable: true, stage: 'page', page: 2 });
    expect(exec).toHaveBeenCalledTimes(3);
    expect(exec.mock.calls.every(([, argv]) => argv[0] === 'api')).toBe(true);
  });

  it('retries page 2 once and returns all ordered rows and metadata', () => {
    const exec = vi.fn().mockReturnValueOnce(page([node(1)], true, 'a', 2))
      .mockImplementationOnce(() => { throw failure(timeout); })
      .mockReturnValueOnce(page([node(2)], false, null, 2));
    const result = list(exec, { heavyFields: [] });
    expect(result).toMatchObject({ rows: [row(1), row(2)], pages: 2, totalCount: 2,
      truncated: false, hydrated: 0, reused: 0, cache: {} });
    expect(result.ms).toBeGreaterThanOrEqual(0);
    expect(exec).toHaveBeenCalledTimes(3);
  });

  it('hydrates selected rows only and keeps untouched open cache entries', () => {
    const cache = { 2: cached(row(2), { body: 'untouched' }), 99: cached(row(99)) };
    delete cache[2].files;
    const before = structuredClone(cache);
    const exec = vi.fn().mockReturnValueOnce(page([node(1), node(2)]))
      .mockReturnValueOnce(JSON.stringify(heavy));
    const result = list(exec, { cache, needsHeavy: r => r.number === 1, execOpts: { timeout: 123 } });
    expect(result.rows).toEqual([{ ...row(1), body: heavy.body, files: heavy.files }, row(2)]);
    expect(result).toMatchObject({ hydrated: 1, reused: 0 });
    expect(exec.mock.calls[1]).toEqual(['gh', ['pr', 'view', '1', '--repo', repo, '--json', 'body,files'],
      { ...opts, timeout: 123 }]);
    expect(Object.keys(result.cache)).toEqual(['1', '2']);
    expect(result.cache[2]).toEqual(cache[2]);
    expect(cache).toEqual(before);
  });

  it('reuses matching snapshot seeds without view calls', () => {
    const seed = [{ ...row(1), ...heavy }, { ...row(2), ...heavy }];
    const exec = vi.fn().mockReturnValueOnce(page([node(1), node(2)]));
    const result = list(exec, { seed });
    expect(result).toMatchObject({ hydrated: 0, reused: 2 });
    expect(result.cache[1]).toEqual({ updatedAt: row(1).updatedAt, headRefOid: row(1).headRefOid,
      fetchedAtMs: 10000, body: heavy.body, files: heavy.files });
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it.each([
    { headRefOid: 'old' }, { updatedAt: 'old' }, { files: undefined },
  ])('hydrates a mismatched or incomplete seed (%j)', extra => {
    const seedRow = { ...row(1), ...heavy, ...extra };
    if (extra.files === undefined && Object.hasOwn(extra, 'files')) delete seedRow.files;
    const exec = vi.fn().mockReturnValueOnce(page([node(1)]))
      .mockReturnValueOnce(JSON.stringify(heavy));
    expect(list(exec, { seed: [seedRow] })).toMatchObject({ hydrated: 1, reused: 0 });
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('prefers a fresh cache over seeds and replaces stale or incomplete entries', () => {
    const seed = [{ ...row(1), ...heavy }];
    for (const entry of [cached(row(1), { fetchedAtMs: 8000 }), cached(row(1), { headRefOid: 'old' }),
      { updatedAt: row(1).updatedAt, headRefOid: row(1).headRefOid, fetchedAtMs: 9500 }]) {
      const exec = vi.fn().mockReturnValueOnce(page([node(1)]));
      expect(list(exec, { cache: { 1: entry }, seed }).rows[0].body).toBe(heavy.body);
      expect(exec).toHaveBeenCalledTimes(1);
    }
    const exec = vi.fn().mockReturnValueOnce(page([node(1)]));
    expect(list(exec, { cache: { 1: cached(row(1), { body: 'cached' }) }, seed }).rows[0].body).toBe('cached');
  });

  it('throws unreadable on a deferred page, including after partial progress', () => {
    const deferred = JSON.stringify({ outcome: 'deferred-low-budget' });
    for (const exec of [vi.fn().mockReturnValueOnce(deferred),
      vi.fn().mockReturnValueOnce(page([node(1)], true, 'a')).mockReturnValueOnce(deferred)]) {
      expect(() => list(exec)).toThrow(PrListUnreadableError);
      exec.mockReset().mockReturnValueOnce(deferred);
      expect(() => list(exec)).toThrow('gh deferred the page (low budget)');
    }
  });

  it('throws unreadable if heavy hydration fails without mutating caller cache', () => {
    const cache = { 99: cached(row(99)) };
    const before = structuredClone(cache);
    const exec = vi.fn().mockReturnValueOnce(page([node(1), node(2)]))
      .mockReturnValueOnce(JSON.stringify(heavy)).mockImplementation(() => { throw failure(timeout); });
    let error;
    try { list(exec, { cache }); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(PrListUnreadableError);
    expect(error).toMatchObject({ unreadable: true, stage: 'hydrate', number: 2 });
    expect(cache).toEqual(before);
  });
});
