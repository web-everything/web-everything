import { beforeEach, afterEach, afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInProcess } from './fixtures/merge-ai-prs-cli-harness.mjs';
import { daemonAppEnv } from './fixtures/daemon-app-env.mjs';

vi.mock('node:child_process', async () => (await import('./fixtures/merge-ai-prs-cli-harness.mjs')).childProcessMock);
const fixture = await vi.hoisted(async () => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'commits-paging-'));
  const state = { root, home: root, disk: undefined, writes: [], reads: [], classifications: [] };
  vi.spyOn(process, 'cwd').mockImplementation(() => state.home);
  return state;
});
vi.mock('node:os', async original => ({ ...await original(), homedir: () => fixture.home,
  userInfo: () => ({ homedir: fixture.home, username: 'fixture', uid: 1, gid: 1, shell: '/bin/sh' }),
}));
vi.mock('node:fs', async original => {
  const fs = await original();
  const isolated = fn => (path, ...args) => {
    if (!String(path).startsWith(fixture.root + '/')) throw new Error('fixture refuses non-temporary data read');
    return fs[fn](path, ...args);
  };
  return { ...fs, readFileSync: isolated('readFileSync'), readdirSync: isolated('readdirSync'), statSync: isolated('statSync') };
});
vi.mock('../lib/settings-files.mjs', async original => ({ ...await original(),
  readSettings: () => ({}), readDeclaredSettings: () => ({ settings: {}, errors: [] }),
}));
vi.mock('../lib/pr-snapshot.mjs', async original => ({ ...await original(), readSharedOpenPrs: () => null,
  readShaCache: ({ kind }) => kind.startsWith('commits') ? fixture.disk : undefined,
  writeShaCache: args => { if (args.kind.startsWith('commits')) fixture.writes.push(args); return true; },
}));
vi.mock('../lib/ai-pr-authorship.mjs', async original => {
  const actual = await original();
  return { ...actual, isAiGeneratedPr: pr => {
    const ai = actual.isAiGeneratedPr(pr);
    fixture.classifications.push({ commits: pr.commits, ai });
    return ai;
  } };
});
vi.mock('../lib/drain-concurrency.mjs', async original => {
  const actual = await original();
  return { ...actual, mapWithConcurrency: async (...args) => {
    const rows = await actual.mapWithConcurrency(...args);
    if (rows[0]?.[1] && Object.hasOwn(rows[0][1], 'cached')) fixture.reads.push(rows[0][1]);
    return rows;
  } };
});
import { meteredPrCommits, meteredPrCommitsAsync } from '../lib/gh-metered-reads.mjs';
import { prReadCacheIdentity, isAiGeneratedPr } from '../merge-ai-prs.mjs';

const HEAD = 'a'.repeat(40), BASE = 'b'.repeat(40), OTHER = 'c'.repeat(40);
const commit = (n, ai = true) => ({ oid: n.toString(16).padStart(40, '0'), messageHeadline: `Implement ${n}`,
  messageBody: '', authors: [{ name: ai ? 'Claude' : 'Human', email: ai ? 'noreply@anthropic.com' : 'human@example.test' }] });
const history = Array.from({ length: 101 }, (_, n) => commit(n + 1, n !== 100));
const page = (commits, { head = HEAD, base = BASE, total = 101, next = false, cursor = 'last' } = {}) => ({
  data: { repository: { pullRequest: { headRefOid: head, baseRefOid: base, commits: {
    totalCount: total, pageInfo: { hasNextPage: next, endCursor: cursor },
    nodes: commits.map(c => ({ commit: { ...c, authors: { nodes: c.authors } } })),
  } } } },
});
const pages = () => [page(history.slice(0, 100), { next: true, cursor: 'page-1' }), page(history.slice(100))];
const connection = p => p.data.repository.pullRequest.commits;
const malformed = [
  ['missing-final-page', () => [pages()[0]], 'missing-terminal-page'],
  ['repeated-page', () => [pages()[0], page([history[0]])], 'duplicate-commit-oid'],
  ['totalCount-mismatch', () => [pages()[0], page(history.slice(100), { total: 102 })], 'inconsistent-total-count'],
  ['head-moved', () => [pages()[0], page(history.slice(100), { head: OTHER })], 'head-oid-mismatch'],
  ['base-moved', () => [pages()[0], page(history.slice(100), { base: OTHER })], 'base-oid-mismatch'],
  ['graphql-errors-with-data', () => [{ ...pages()[0], errors: [{ message: 'partial' }] }], 'graphql-errors'],
  ['missing-oid', () => { const p = pages(); delete connection(p[1]).nodes[0].commit.oid; return p; }, 'invalid-commit-oid'],
  ['invalid-oid', () => { const p = pages(); connection(p[1]).nodes[0].commit.oid = 'invalid'; return p; }, 'invalid-commit-oid'],
  ['inconsistent-per-page-count', () => [page(history, { total: 100 })], 'invalid-page-count'],
  ['nonterminal-at-totalCount', () => [page(history.slice(0, 100), { total: 100, next: true, cursor: 'more' }), page([], { total: 100 })], 'invalid-page-count'],
  ['invalid-pageInfo', () => { const p = pages(); connection(p[1]).pageInfo.hasNextPage = 'false'; return p; }, 'invalid-page-info'],
  ['premature-terminal-page', () => [page(history.slice(0, 100))], 'premature-terminal-page'],
  ['malformed-json-shape', () => ({}), 'invalid-pages'],
  ['missing-page-identity', () => { const p = pages(); delete p[1].data.repository.pullRequest.baseRefOid; return p; }, 'invalid-page-identity'],
  ['invalid-page-identity', () => [page(history.slice(0, 100), { head: 'bad' })], 'invalid-page-identity'],
  ['page-after-terminal', () => [page(history.slice(0, 100), { total: 100 }), page(history.slice(100))], 'page-after-terminal'],
  ['repeated-cursor', () => [pages()[0], page(history.slice(100), { cursor: 'page-1' })], 'repeated-cursor'],
];

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(fixture.root, 'case-')); fixture.home = dir;
  vi.spyOn(process, 'cwd').mockReturnValue(dir);
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-27T22:00:00Z'));
  mkdirSync(join(dir, 'backlog'));
  writeFileSync(join(dir, 'gh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  fixture.disk = undefined; fixture.writes = []; fixture.reads = []; fixture.classifications = [];
});
afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });
afterAll(() => rmSync(fixture.root, { recursive: true, force: true }));

async function drain({ response = pages(), rows = history, seedOuter = false, body = '', outerVersion = 'v1', cachedBody = '', prOverrides = {} } = {}) {
  const calls = [];
  const pr = { number: 1, title: 'fixture', body, headRefName: 'lane/fixture', headRefOid: HEAD,
    baseRefName: 'main', baseRefOid: BASE, isDraft: true, labels: [{ name: 'ready-to-merge' }], files: [], statusCheckRollup: [], ...prOverrides };
  const seeded = new Set();
  if (seedOuter) {
    const get = Map.prototype.get;
    vi.spyOn(Map.prototype, 'get').mockImplementation(function(key) {
      // Inject persisted v1 values only into the two real production read-cache lookups.
      if (key === 'cwd::1' && new Error().stack.includes('fetchPrReadsCached') && !seeded.has(this)) {
        seeded.add(this);
        this.set(key, { sha: outerVersion === 'v1' ? JSON.stringify([HEAD, cachedBody]) : prReadCacheIdentity({ ...pr, body: cachedBody }), value: { commits: history.slice(0, 100), manifest: null } });
      }
      return get.call(this, key);
    });
  }
  const gh = args => {
    calls.push(args);
    if (args.includes('--repo') && args[args.indexOf('--repo') + 1] !== 'fixture/repo') return { status: 0, stdout: '[]' };
    if (args[0] === 'repo') return { status: 0, stdout: 'main' };
    if (args[0] === 'pr' && args[1] === 'list') return { status: 0, stdout: JSON.stringify([pr]) };
    if (args[0] === 'pr' && args[1] === 'view') return { status: 0, stdout: JSON.stringify({ ...pr, commits: rows.slice(0, 100) }) };
    const query = args.find(a => a.startsWith('query=')) ?? '';
    if (query.includes('pullRequests(') && !query.includes('repository(owner:"fixture",name:"repo")')) return { status: 0, stdout: JSON.stringify({ data: { repository: { pullRequests: { totalCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } }) };
    if (query.includes('pullRequests(')) return { status: 0, stdout: JSON.stringify({ data: { repository: { pullRequests: {
      totalCount: 1, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ ...pr, labels: { nodes: pr.labels }, commits: { nodes: [] } }],
    } } } }) };
    if (args.some(a => a.includes('/check-runs?'))) return { status: 0, stdout: JSON.stringify([{ total_count: 1, check_runs: [{ id: 1, name: 'test', head_sha: HEAD, status: 'completed', conclusion: 'success' }] }]) };
    if (args.some(a => a.includes('/status?'))) return { status: 0, stdout: JSON.stringify([{ total_count: 0, statuses: [] }]) };
    if (args[0] === 'api' && args[1] === 'graphql') {
      if (response instanceof Error) return { status: 1, stdout: '', stderr: response.message };
      return { status: 0, stdout: JSON.stringify(response) };
    }
    return { status: 0, stdout: '[]' };
  };
  const cli = await runInProcess(['--this-repo', '--label=ready-to-merge', '--dry-run', '--no-drain-lease', '--no-red-main-freeze', '--json'], {
    cwd: dir, env: { ...daemonAppEnv(dir), PATH: dir, TMPDIR: dir, WE_PR_SNAPSHOT: '0' },
    ports: { gh, git: args => args.includes('get-url') || args.includes('remote.origin.url')
      ? { status: 0, stdout: 'https://github.com/fixture/repo.git\n' }
      : ['cat-file', 'ls-tree'].some(op => args.includes(op)) ? { status: 0, stdout: '' }
      : { status: 128, stdout: '', stderr: 'fixture has no revision' } },
  });
  return { cli, calls, seeded, reads: fixture.reads, writes: fixture.writes, classifications: fixture.classifications,
    apiCalls: calls.filter(a => a[0] === 'api' && a[1] === 'graphql' && a.includes('--slurp')) };
}

function expectObservedClassification(result, ai) {
  expect(result.reads).toHaveLength(2);
  for (const read of result.reads) {
    const observed = result.classifications.filter(c => c.commits === read.value.commits);
    expect(observed.length, result.cli.stderr).toBeGreaterThan(0);
    expect(observed.every(c => c.ai === ai)).toBe(true);
  }
}

it('PR-HEAD-CHAIN-RECORD: drain authorship reads every page past 100 commits', async () => {
  expect(isAiGeneratedPr({ commits: history.slice(0, 100) })).toBe(true);
  const result = await drain();
  expect(result.cli.status, result.cli.stderr).toBe(0);
  expectObservedClassification(result, false);
  expect(result.reads).toHaveLength(2);
  for (const read of result.reads) expect(read.value.commits).toEqual(history);
  expect(result.apiCalls.length).toBeGreaterThan(0);
});
it('legacy truncated sha cache is not trusted', async () => {
  fixture.disk = history.slice(0, 100);
  const result = await drain();
  expectObservedClassification(result, false);
  expect(result.apiCalls.length).toBeGreaterThan(0);
  expect(result.writes.length).toBeGreaterThan(0);
  for (const w of result.writes) expect(w).toMatchObject({ kind: 'commits-v2', value: { complete: true, commits: history } });
});
it('outer-cache-hit-with-truncated-evidence-refetched: context and sweep production paths', async () => {
  const result = await drain({ seedOuter: true });
  expect(result.seeded.size).toBe(2);
  expect(result.reads).toHaveLength(2);
  for (const read of result.reads) expect(read).toMatchObject({ cached: false, value: { commits: history, degraded: false } });
  expect(result.writes).toHaveLength(2);
  expect(result.apiCalls).toHaveLength(2);
  expectObservedClassification(result, false);
});
it('body edits invalidate both production v2 outer caches at the same head', async () => {
  const result = await drain({ seedOuter: true, outerVersion: 'v2', body: 'edited dependencies' });
  expect(result.seeded.size).toBe(2);
  for (const read of result.reads) expect(read.cached).toBe(false);
  expect(result.apiCalls).toHaveLength(2);
  expect(result.writes).toHaveLength(2);
  expectObservedClassification(result, false);
});
it('valid v2 all-AI outer-cache hits keep both drain paths certified without a refetch', async () => {
  const result = await drain({ seedOuter: true, outerVersion: 'v2', rows: history.slice(0, 100) });
  expect(result.seeded.size).toBe(2);
  for (const read of result.reads) expect(read.cached).toBe(true);
  expect(result.apiCalls).toEqual([]);
  expect(result.writes).toEqual([]);
  expectObservedClassification(result, true);
});
it.each([
  ['timeout', new Error('ETIMEDOUT fixture')],
  ['max-buffer', new Error('ERR_CHILD_PROCESS_STDIO_MAXBUFFER fixture')],
  ['commit-limit', [page(history.slice(0, 100), { total: 100_001, next: true })]],
])('%s overflow gives empty evidence, no cache write and a named operator fallback', async (reason, response) => {
  const result = await drain({ response, seedOuter: true });
  expect(result.seeded.size).toBe(2);
  expect(result.apiCalls).toHaveLength(2);
  for (const read of result.reads) expect(read).toMatchObject({ cached: false, value: { commits: [], degraded: true } });
  expect(result.writes).toEqual([]);
  for (const map of result.seeded) expect(map.get('cwd::1').sha).toBe(JSON.stringify([HEAD, '']));
  expect(result.cli.stderr).toContain(reason);
  expect(result.cli.stderr).toContain('inspect PR history manually');
  expectObservedClassification(result, false);
});
it('a drain listing without baseRefOid refuses authorship without calling GitHub or writing a cache', async () => {
  const result = await drain({ prOverrides: { baseRefOid: undefined } });
  expect(result.apiCalls).toEqual([]);
  expect(result.writes).toEqual([]);
  expect(result.cli.stderr).toContain('invalid-expected-identity');
  expectObservedClassification(result, false);
});
it('outer body-sensitive invalidation survives v2 identities', () => {
  const p = { headRefOid: HEAD, baseRefOid: BASE, headRefName: 'lane/fixture', baseRefName: 'main', body: '' };
  expect(prReadCacheIdentity({ ...p, body: 'edited' })).not.toBe(prReadCacheIdentity(p));
  for (const field of ['headRefOid', 'baseRefOid', 'headRefName', 'baseRefName']) {
    expect(prReadCacheIdentity({ ...p, [field]: OTHER })).not.toBe(prReadCacheIdentity(p));
    expect(prReadCacheIdentity({ ...p, [field]: null })).toBeNull();
  }
});
it('at most 100 all-AI commits certify through both drain paths with baseRefOid', async () => {
  const rows = history.slice(0, 100);
  const result = await drain({ rows, response: [page(rows, { total: 100 })] });
  expectObservedClassification(result, true);
  expect(result.reads).toHaveLength(2);
  for (const read of result.reads) expect(read.value).toMatchObject({ commits: rows, degraded: false });
  expect(result.writes).toHaveLength(2);
});
it.each(malformed)('%s: empty evidence, no cache write, named reason through both drain paths', async (_name, make, reason) => {
  const result = await drain({ response: make(), seedOuter: true });
  expect(result.seeded.size).toBe(2);
  expect(result.reads).toHaveLength(2);
  for (const read of result.reads) expect(read).toMatchObject({ cached: false, value: { commits: [], degraded: true } });
  expectObservedClassification(result, false);
  expect(result.writes).toEqual([]);
  for (const map of result.seeded) expect(map.get('cwd::1').sha).toBe(JSON.stringify([HEAD, '']));
  expect(result.apiCalls).toHaveLength(2);
  expect(result.cli.stderr).toContain(reason);
});

describe.each([['sync', meteredPrCommits], ['async', (...args) => meteredPrCommitsAsync(...args)]])('%s paged commit contract', (_mode, read) => {
  const run = async (response, extra = {}) => {
    const exec = vi.fn(() => { if (response instanceof Error) throw response; return JSON.stringify(response); });
    const result = await read('fixture/repo', 1, { exec, headRefOid: HEAD, baseRefOid: BASE, ...extra });
    return { exec, result };
  };
  it('one slurped exec proves complete identity, counts and unique commits', async () => {
    const { exec, result } = await run(pages());
    expect(exec).toHaveBeenCalledOnce();
    const [args, opts] = exec.mock.calls[0];
    expect(args).toEqual(expect.arrayContaining(['--paginate', '--slurp'])); expect(args).not.toContain('--jq');
    expect(args.find(a => a.startsWith('query='))).toMatch(/headRefOid baseRefOid/);
    expect(opts).toMatchObject({ timeout: 120_000, maxBuffer: 64 * 1024 * 1024, killSignal: 'SIGKILL' });
    expect(result).toMatchObject({ complete: true, headOid: HEAD, baseOid: BASE, commits: history });
  });
  it.each(malformed)('%s refuses partial evidence: %s', async (_name, make, reason) => {
    const { exec, result } = await run(make());
    expect(exec).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ complete: false, commits: [], reason });
  });
  it.each([['timeout', { code: 'ETIMEDOUT' }], ['max-buffer', { code: 'ENOBUFS' }],
    ['max-buffer', { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }], ['read-failed', { status: 1 }]])('%s refuses subprocess failure', async (reason, props) => {
    const { exec, result } = await run(Object.assign(new Error('fixture failure'), props));
    expect(exec).toHaveBeenCalledOnce(); expect(result).toMatchObject({ complete: false, commits: [], reason });
  });
  it.each([100_000, 100_001])('%i commits respects the aggregate limit', async count => {
    const rows = Array.from({ length: count }, (_, n) => commit(n + 1));
    const response = Array.from({ length: Math.ceil(count / 100) }, (_, n) =>
      page(rows.slice(n * 100, n * 100 + 100), { total: count, next: n * 100 + 100 < count, cursor: `page-${n}` }));
    const { exec, result } = await run(response);
    expect(exec).toHaveBeenCalledOnce();
    if (count === 100_000) { expect(result.complete).toBe(true); expect(result.commits).toHaveLength(count); }
    else { expect(result.complete).toBe(false); expect(result.commits).toEqual([]); expect(result.reason).toBe('commit-limit'); }
  });
  it.each(['headRefOid', 'baseRefOid'])('missing expected %s fails closed', async field => {
    const { result } = await run(pages(), { [field]: null });
    expect(result).toMatchObject({ complete: false, commits: [], reason: 'invalid-expected-identity' });
  });
});

it('cap API complete fallback resolves and incomplete fallback is unresolved', async () => {
  const { fetchOpenPrs, fetchPrCommits } = await import('../lib/pr-limit.mjs');
  const exec = vi.fn(args => args[1] === 'list' ? JSON.stringify([{ number: 1, headRefName: 'lane/fixture',
    headRefOid: HEAD, baseRefName: 'main', baseRefOid: BASE }]) : JSON.stringify(pages()));
  const [pr] = fetchOpenPrs('fixture/repo', { exec, readShared: () => null });
  expect(exec.mock.calls[0][0][exec.mock.calls[0][0].indexOf('--json') + 1]).toContain('baseRefOid');
  const opts = { ...pr, exec, cwd: dir, git: () => { throw new Error('fixture local miss'); } };
  expect(fetchPrCommits('fixture/repo', 1, opts)).toEqual(history);
  exec.mockImplementation(() => JSON.stringify([pages()[0]]));
  expect(fetchPrCommits('fixture/repo', 1, opts)).toBeNull();
  expect(exec).toHaveBeenCalledTimes(3);
});
