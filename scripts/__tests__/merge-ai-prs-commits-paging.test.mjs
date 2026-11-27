import { beforeEach, afterEach, afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInProcess } from './fixtures/merge-ai-prs-cli-harness.mjs';
import { daemonAppEnv } from './fixtures/daemon-app-env.mjs';

vi.mock('node:child_process', async () => (await import('./fixtures/merge-ai-prs-cli-harness.mjs')).childProcessMock);
const cache = await vi.hoisted(async () => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'head-chain-home-'));
  const state = { value: undefined, writes: [], home: root, root };
  vi.spyOn(process, 'cwd').mockImplementation(() => state.home);
  return state;
});
vi.mock('node:os', async importOriginal => ({ ...await importOriginal(), homedir: () => cache.home,
  userInfo: () => ({ homedir: cache.home, username: 'fixture', uid: 1, gid: 1, shell: '/bin/sh' }),
}));
vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal();
  return { ...fs, readFileSync: (path, ...args) => {
    if (!String(path).startsWith(cache.root + '/')) throw new Error('fixture refuses non-temporary data read');
    return fs.readFileSync(path, ...args);
  } };
});
vi.mock('../lib/settings-files.mjs', async importOriginal => ({ ...await importOriginal(),
  readSettings: () => ({}), readDeclaredSettings: () => ({ settings: {}, errors: [] }),
}));
vi.mock('../lib/pr-snapshot.mjs', async importOriginal => ({
  ...await importOriginal(), readSharedOpenPrs: () => null,
  readShaCache: ({ kind }) => kind === 'commits' ? cache.value : undefined,
  writeShaCache: args => { if (args.kind === 'commits') cache.writes.push(args.value); return true; },
}));
import { meteredPrCommits, meteredPrCommitsAsync } from '../lib/gh-metered-reads.mjs';
import { fetchPrReadsCached, prReadCacheIdentity, isAiGeneratedPr } from '../merge-ai-prs.mjs';

const HEAD = 'a'.repeat(40), BASE = 'b'.repeat(40), OTHER = 'c'.repeat(40);
const commit = (n, ai = true) => ({ oid: n.toString(16).padStart(40, '0'),
  messageHeadline: `Implement ${n}`, messageBody: '', authors: [{ name: ai ? 'Claude' : 'Human', email: ai ? 'noreply@anthropic.com' : 'human@example.test' }] });
const history = Array.from({ length: 101 }, (_, n) => commit(n + 1, n !== 100));
const page = (commits, { head = HEAD, base = BASE, total = 101, next = false, cursor = 'last' } = {}) => ({
  data: { repository: { pullRequest: { headRefOid: head, baseRefOid: base, commits: {
    totalCount: total, pageInfo: { hasNextPage: next, endCursor: cursor },
    nodes: commits.map(c => ({ commit: { ...c, authors: { nodes: c.authors } } })),
  } } } },
});
const pages = () => [page(history.slice(0, 100), { next: true, cursor: 'page-1' }), page(history.slice(100))];
function executor(responses) {
  return vi.fn(args => {
    // The original reader delegates pagination to gh; the corrected reader verifies each requested cursor.
    if (args.includes('--paginate')) return JSON.stringify(responses);
    const after = args.find(a => a.startsWith('endCursor='))?.slice(10);
    return JSON.stringify(after === undefined ? responses[0] : responses[1]);
  });
}

describe('PR-HEAD-CHAIN-RECORD', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(cache.root, 'pages-')); cache.home = dir;
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    mkdirSync(join(dir, 'backlog'));
    writeFileSync(join(dir, 'gh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    cache.value = undefined; cache.writes = [];
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-27T22:00:00Z'));
  });
  afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });
  afterAll(() => rmSync(cache.root, { recursive: true, force: true }));

  async function drain() {
    const calls = [];
    const pr = { number: 1, title: 'fixture', body: '', headRefName: 'lane/fixture', headRefOid: HEAD,
      baseRefName: 'main', baseRefOid: BASE, isDraft: true, labels: [], files: [], statusCheckRollup: [] };
    const gh = args => {
      calls.push(args);
      if (args[0] === 'repo') return { status: 0, stdout: 'main' };
      if (args[0] === 'pr' && args[1] === 'list') return { status: 0, stdout: JSON.stringify([pr]) };
      if (args[0] === 'pr' && args[1] === 'view') return { status: 0, stdout: JSON.stringify({ ...pr, commits: history.slice(0, 100) }) };
      if (args.find(a => a.startsWith('query='))?.includes('pullRequests(')) return { status: 0, stdout: JSON.stringify({
        data: { repository: { pullRequests: { totalCount: 1, pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [{ ...pr, labels: { nodes: [] }, commits: { nodes: [] } }] } } },
      }) };
      if (args[0] === 'api' && args[1] === 'graphql') return { status: 0, stdout: executor(pages())(args) };
      return { status: 0, stdout: '[]' };
    };
    const cli = await runInProcess(['--this-repo', '--dry-run', '--no-drain-lease', '--no-red-main-freeze', '--no-reconcile-labels', '--json'], {
      cwd: dir, env: { ...daemonAppEnv(dir), PATH: dir, TMPDIR: dir, WE_PR_SNAPSHOT: '0' },
      ports: { gh, git: args => args.includes('get-url') || args.includes('remote.origin.url')
        ? { status: 0, stdout: 'https://github.com/fixture/repo.git\n' }
        : { status: 128, stdout: '', stderr: 'fixture has no revision' } },
    });
    const value = cache.writes.at(-1) ?? cache.value;
    const commits = Array.isArray(value) ? value : value?.commits;
    return { commits, calls, cli };
  }
  it('PR-HEAD-CHAIN-RECORD: drain authorship reads every page past 100 commits', async () => {
    const result = await drain();
    expect(isAiGeneratedPr({ commits: result.commits })).toBe(false);
    expect(result.commits, JSON.stringify(result)).toHaveLength(101);
    expect(result.calls.some(a => a.includes('graphql'))).toBe(true);
  });
  it('legacy truncated sha cache is not trusted', async () => {
    cache.value = history.slice(0, 100);
    const result = await drain();
    expect(isAiGeneratedPr({ commits: result.commits })).toBe(false);
    expect(result.commits).toHaveLength(101);
  });
  it.each(['context', 'sweep'])('outer-cache-hit-with-truncated-evidence-refetched: %s', async path => {
    const pr = { number: 1, headRefOid: HEAD, baseRefOid: BASE, headRefName: 'lane/fixture', baseRefName: 'main', body: '' };
    const key = `${path}:1`, store = new Map([[key, { sha: JSON.stringify([HEAD, '']), value: history.slice(0, 100) }]]);
    const fetchOne = vi.fn(async () => history);
    const result = await fetchPrReadsCached([pr], { cache: store, keyOf: () => key, shaOf: prReadCacheIdentity, fetchOne });
    expect(isAiGeneratedPr({ commits: result.get(key).value })).toBe(false);
    expect(fetchOne).toHaveBeenCalledOnce();
  });
  it('paged read proves the requested cursor chain and both identities', () => {
    const exec = executor(pages());
    expect(meteredPrCommits('fixture/repo', 1, { exec, headRefOid: HEAD, baseRefOid: BASE }))
      .toMatchObject({ complete: true, headOid: HEAD, baseOid: BASE, commits: history });
    expect(exec.mock.calls).toHaveLength(2);
    expect(exec.mock.calls[0][0].some(a => a.startsWith('endCursor='))).toBe(false);
    expect(exec.mock.calls[1][0]).toContain('endCursor=page-1');
    for (const [, opts] of exec.mock.calls) expect(opts).toMatchObject({ timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
  });
  it('cap API fallback consumes the verified object and lists the expected base oid', async () => {
    const { fetchOpenPrs, fetchPrCommits } = await import('../lib/pr-limit.mjs');
    const exec = vi.fn(args => {
      if (args[1] === 'list') {
        const fields = args[args.indexOf('--json') + 1].split(',');
        const pr = { number: 1, headRefName: 'lane/fixture', headRefOid: HEAD, baseRefName: 'main', baseRefOid: BASE };
        return JSON.stringify([Object.fromEntries(Object.entries(pr).filter(([key]) => fields.includes(key)))]);
      }
      return executor(pages())(args);
    });
    const [pr] = fetchOpenPrs('fixture/repo', { exec, readShared: () => null });
    const commits = fetchPrCommits('fixture/repo', 1, { ...pr, exec, cwd: dir, git: () => { throw Error('fixture-local-miss'); } });
    expect(commits).toHaveLength(101);
    expect(isAiGeneratedPr({ commits })).toBe(false);
  });
  describe.each([
    ['sync', meteredPrCommits], ['async', meteredPrCommitsAsync],
  ])('%s commit resource bounds', (_mode, read) => {
    it('stops at 1,000 pages with no partial commits when another page remains', async () => {
      let requested = 0;
      const exec = vi.fn(args => {
        const previous = requested++;
        expect(args.filter(a => a.startsWith('endCursor=')))
          .toEqual(previous ? [`endCursor=page-${previous}`] : []);
        if (requested > 1000) throw new Error('unexpected request beyond page bound');
        return JSON.stringify(page([commit(requested)], { total: 1001, next: true, cursor: `page-${requested}` }));
      });
      const result = await read('fixture/repo', 1, { exec, headRefOid: HEAD, baseRefOid: BASE });
      expect(result).toMatchObject({ complete: false, commits: [], reason: 'commits-page-limit: operator inspection required' });
      expect(exec).toHaveBeenCalledTimes(1000);
    });
    it('refuses a total over 100,000 commits without requesting another page', async () => {
      const exec = vi.fn(() => JSON.stringify(page([commit(1)], { total: 100_001, next: true, cursor: 'more' })));
      const result = await read('fixture/repo', 1, { exec, headRefOid: HEAD, baseRefOid: BASE });
      expect(result).toMatchObject({ complete: false, commits: [], reason: 'invalid-commits-page' });
      expect(exec).toHaveBeenCalledOnce();
    });
    it('allows exactly 64 MiB then refuses cumulative output above it with no partial commits or further requests', async () => {
      let requested = 0;
      const exec = vi.fn(() => {
        requested++;
        if (requested > 5) throw new Error('unexpected request beyond output bound');
        const raw = JSON.stringify(page([commit(requested)], { total: 6, next: true, cursor: `page-${requested}` }));
        // Each response stays within the subprocess 16 MiB cap. Four responses reach
        // exactly 64 MiB; the fifth crosses the cumulative bound before parsing.
        return requested <= 4 ? raw.padEnd(16 * 1024 * 1024, ' ') : raw;
      });
      const result = await read('fixture/repo', 1, { exec, headRefOid: HEAD, baseRefOid: BASE });
      expect(result).toMatchObject({ complete: false, commits: [], reason: 'commits-output-limit: operator inspection required' });
      expect(exec).toHaveBeenCalledTimes(5);
    });
  });
  it.each([
    ['head-moves-between-pages', () => [pages()[0], page(history.slice(100), { head: OTHER })]],
    ['base-moves-between-pages', () => [pages()[0], page(history.slice(100), { base: OTHER })]],
    ['pagination-missing-first-page', () => [pages()[1]]],
    ['pagination-missing-middle-page', () => [page(history.slice(0, 50), { next: true }), page(history.slice(100))]],
    ['pagination-missing-final-page', () => [pages()[0]]],
    ['pagination-repeated-page', () => [pages()[0], page([history[0]])]],
    ['pagination-total-count-mismatch', () => [pages()[0], page(history.slice(100), { total: 102 })]],
    ['pagination-cursor-does-not-chain', () => [pages()[0], page(history.slice(100), { next: true, cursor: 'page-1' })]],
    ['malformed-page', () => [{}]],
    ['graphql-partial-error', () => [{ ...pages()[0], errors: [{ message: 'incomplete' }] }]],
  ])('%s refuses incomplete evidence', (_name, fixture) => {
    const result = meteredPrCommits('fixture/repo', 1, { exec: executor(fixture()), headRefOid: HEAD, baseRefOid: BASE });
    expect(result.complete).toBe(false);
    expect(result.commits).toEqual([]);
    expect(result.reason).toBeTruthy();
  });
  it.each(['baseRefOid', 'headRefOid'])('unknown %s refuses evidence', field => {
    const result = meteredPrCommits('fixture/repo', 1, { exec: executor(pages()), headRefOid: HEAD, baseRefOid: BASE, [field]: null });
    expect(result.complete).toBe(false);
  });
  it.each(['baseRefOid', 'headRefOid', 'baseRefName', 'headRefName'])('outer cache identity changes with %s', field => {
    const pr = { headRefOid: HEAD, baseRefOid: BASE, baseRefName: 'main', headRefName: 'lane/fixture', body: '' };
    expect(prReadCacheIdentity({ ...pr, [field]: OTHER })).not.toBe(prReadCacheIdentity(pr));
    expect(prReadCacheIdentity({ ...pr, [field]: null })).toBeNull();
  });
});
