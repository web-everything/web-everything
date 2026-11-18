/**
 * @file scripts/lib/__tests__/pr-list-paged.test.mjs
 * @description Hermetic paging, gh-shape mapping, heavy-field freshness and policy cascade probes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  rollupEvidence, buildOpenPrPageQuery, mapGraphqlPr, parseOpenPrPage, isTransientGhFailure, heavyIsFresh, resolveCheckAppsByCommit,
  listOpenPrsLightPaged, listOpenPrsPagedHydrated, assertInventoryComplete, listOpenPrsPagedHydratedComplete, parseListOutput, hydrateHeavyFields, resolvePrListPaging, PrListUnreadableError,
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
const externalNodes = ids => ids.map(id => node(id, {
  commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [{
    __typename: 'CheckRun', name: 'red-team', status: 'IN_PROGRESS', databaseId: id,
    checkSuite: { app: null, workflowRun: null },
  }] } } } }] },
}));

describe('commit app lookup progress', () => {
  let dir, env;
  const sha = i => i.toString(16).padStart(40, '0');
  const pendingRows = ids => ids.map(i => ({ headRefOid: sha(i), statusCheckRollup: [{
    __typename: 'CheckRun', name: 'red-team', status: 'IN_PROGRESS',
  }] }));
  const response = JSON.stringify({ total_count: 1, check_runs: [{
    name: 'red-team', status: 'in_progress', app: { id: 42, slug: 'red-team' },
  }] });
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'commit-app-cursor-'));
    env = { ...process.env, WE_PR_SNAPSHOT_DIR: dir };
  });
  afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

  it('covers every pending head at the runner two-minute refresh interval', () => {
    const shas = Array.from({ length: 40 }, (_, i) => (i + 1).toString(16).padStart(40, '0'));
    const queried = new Set();
    const clock = vi.spyOn(Date, 'now');
    for (const now of [0, 120000, 240000, 360000, 480000]) {
      clock.mockReturnValue(now);
      const rows = shas.map(headRefOid => ({ headRefOid, statusCheckRollup: [{
        __typename: 'CheckRun', name: 'red-team', status: 'IN_PROGRESS',
      }] }));
      const exec = vi.fn((_cmd, args) => {
        queried.add(args[1].match(/commits\/([0-9a-f]{40})\//)[1]);
        return JSON.stringify({ total_count: 1, check_runs: [{
          name: 'red-team', status: 'in_progress', app: { id: 42, slug: 'red-team' },
        }] });
      });
      resolveCheckAppsByCommit({ repo: 'progress/two-minute', rows, exec, env });
      expect(exec.mock.calls.length).toBeLessThanOrEqual(30);
    }
    expect(queried.size).toBe(40);
  });

  it.each([31, 60, 70])('advances with a frozen clock and failed reads for %i heads', count => {
    vi.spyOn(Date, 'now').mockReturnValue(0);
    const queried = new Set();
    const ids = Array.from({ length: count }, (_, i) => i + 1);
    for (let refresh = 0; refresh < Math.ceil(count / 30); refresh++) {
      const rows = pendingRows(ids);
      const exec = vi.fn((_cmd, args) => {
        queried.add(args[1].match(/commits\/([0-9a-f]{40})\//)[1]);
        if (refresh % 2 === 0) throw new Error('unavailable');
        return '{malformed';
      });
      resolveCheckAppsByCommit({ repo: 'progress/failures', rows, exec, env });
      expect(exec).toHaveBeenCalledTimes(30);
      expect(rows.every(r => !r.statusCheckRollup[0].appId)).toBe(true);
    }
    expect(queried.size).toBe(count);
  });

  it('continues beyond a removed cursor head despite reordered rows and duplicate heads', () => {
    const ids = Array.from({ length: 70 }, (_, i) => i + 1);
    resolveCheckAppsByCommit({ repo: 'progress/churn', rows: pendingRows(ids), exec: () => response, env });
    const rows = pendingRows([...ids.filter(i => i !== 30).reverse(), 31]);
    const calls = [];
    resolveCheckAppsByCommit({ repo: 'progress/churn', rows, env, exec: (_cmd, args) => {
      calls.push(args[1].match(/commits\/([0-9a-f]{40})\//)[1]);
      return response;
    } });
    expect(calls).toEqual(ids.slice(30, 60).map(sha));
    expect(rows.filter(r => r.headRefOid === sha(31)).every(r => r.statusCheckRollup[0].appId === 42)).toBe(true);
  });

  it('keeps repository and cwd progress independent', () => {
    const ids = Array.from({ length: 40 }, (_, i) => i + 1);
    const localEnv = { ...env, GH_REPO: '' };
    for (const scope of [{ repo: 'progress/a' }, { repo: 'progress/b' },
      { repo: null, execOpts: { cwd: join(dir, 'a') } }, { repo: null, execOpts: { cwd: join(dir, 'b') } }]) {
      const rows = pendingRows(ids);
      resolveCheckAppsByCommit({ ...scope, rows, exec: () => response, env: localEnv });
      expect(rows.filter(r => r.statusCheckRollup[0].appId).map(r => r.headRefOid)).toEqual(ids.slice(0, 30).map(sha));
    }
  });

  it('publishes and unlocks the reservation before an interleaved reader starts REST IO', () => {
    const ids = Array.from({ length: 60 }, (_, i) => i + 1);
    const outer = pendingRows(ids);
    const inner = pendingRows(ids);
    let interleaved = false;
    resolveCheckAppsByCommit({ repo: 'progress/interleaved', rows: outer, env, exec: () => {
      if (!interleaved) {
        interleaved = true;
        resolveCheckAppsByCommit({ repo: 'progress/interleaved', rows: inner, env, exec: () => response });
      }
      return response;
    } });
    const hydrated = rows => rows.filter(r => r.statusCheckRollup[0].appId).map(r => r.headRefOid);
    expect(hydrated(outer)).toEqual(ids.slice(0, 30).map(sha));
    expect(hydrated(inner)).toEqual(ids.slice(30).map(sha));
  });

  it('recovers a corrupt cursor and then advances on the following refresh', () => {
    const ids = Array.from({ length: 40 }, (_, i) => i + 1);
    const fetch = () => {
      const rows = pendingRows(ids);
      resolveCheckAppsByCommit({ repo: 'progress/corrupt', rows, exec: () => response, env });
      return rows.filter(r => r.statusCheckRollup[0].appId).map(r => r.headRefOid);
    };
    fetch();
    const cursorDir = join(dir, 'commit-app-cursors');
    writeFileSync(join(cursorDir, readdirSync(cursorDir)[0]), '{broken');
    expect(fetch()).toEqual(ids.slice(0, 30).map(sha));
    expect(fetch()).toContain(sha(40));
  });

  it('leaves unknown apps closed and reports unavailable cursor storage', () => {
    const blocked = join(dir, 'not-a-directory');
    writeFileSync(blocked, 'occupied');
    const rows = pendingRows(Array.from({ length: 40 }, (_, i) => i + 1));
    const exec = vi.fn(() => response);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    resolveCheckAppsByCommit({ repo: 'progress/blocked', rows, exec, env: { ...env, WE_PR_SNAPSHOT_DIR: blocked } });
    expect(exec).not.toHaveBeenCalled();
    expect(rows.every(r => !r.statusCheckRollup[0].appId)).toBe(true);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('restore writable PR snapshot storage'));
  });
});

describe('query and gh row shape', () => {
  it('builds first and subsequent pages, quotes cursors and rejects invalid repos', () => {
    const q = buildOpenPrPageQuery({ repo, pageSize: 20 });
    expect(q).toContain('repository(owner:"owner",name:"name")');
    expect(q).toContain('states:OPEN,first:20,orderBy:');
    expect(q).not.toContain('after:');
    expect(q).toContain('commit{oid statusCheckRollup{contexts(first:100){pageInfo{hasNextPage} totalCount nodes{');
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
    expect(mapGraphqlPr(n)).toEqual({ rowsHead: null, rowsComplete: false, ...node(1), reviewDecision: '', labels: n.labels.nodes, statusCheckRollup: [
      { __typename: 'CheckRun', completedAt: '0001-01-01T00:00:00Z', conclusion: '', detailsUrl: check.detailsUrl,
        name: 'test', startedAt: '0001-01-01T00:00:00Z', status: 'IN_PROGRESS', workflowName: '', appSlug: '', appId: null },
      { __typename: 'StatusContext', context: 'ci', startedAt: 'today', state: 'PENDING', targetUrl: '' },
    ] });
    expect(Object.keys(row(1)).filter(k => !['rowsHead', 'rowsComplete'].includes(k))).toEqual(PAGED_LIGHT_FIELDS);
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
      // GH_REPO lets the per-owner App token shim route `gh api graphql` (no --repo flag) to the right owner.
      expect(options).toEqual({ ...opts, env: expect.objectContaining({ GH_REPO: repo }) });
    }
    expect(exec.mock.calls[1][1][3]).toContain('after:"a"');
  });
  it('resolves the posting app over REST for a live workflow-less check, because GraphQL hides checkSuite.app (live #6873)', () => {
    const check = id => ({ __typename: 'CheckRun', name: 'red-team', status: 'IN_PROGRESS', conclusion: null, startedAt: 's', completedAt: null,
      detailsUrl: 'https://example.invalid/x', databaseId: id, checkSuite: { app: null, workflowRun: null } });
    const n = node(1, { commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [check(777)] } } } }] } });
    const exec = vi.fn().mockReturnValueOnce(page([n])).mockReturnValueOnce(JSON.stringify({ app: { id: 5037855, slug: 'web-everything' } }));
    const row = listOpenPrsLightPaged({ repo, exec, pageSize: 20 }).rows[0].statusCheckRollup[0];
    expect(row).toMatchObject({ name: 'red-team', appId: 5037855, appSlug: 'web-everything' });
    expect(exec.mock.calls[1][1]).toEqual(['api', `repos/${repo}/check-runs/777`]);
    // an unreadable REST answer leaves the app empty (the planner then fails closed)
    const bad = vi.fn().mockReturnValueOnce(page([n])).mockImplementationOnce(() => { throw new Error('boom'); });
    expect(listOpenPrsLightPaged({ repo, exec: bad, pageSize: 20, checkAppState: {} }).rows[0].statusCheckRollup[0]).toMatchObject({ appId: null, appSlug: '' });
    // a completed or workflow-bearing check costs no extra call
    const done = vi.fn().mockReturnValueOnce(page([node(1, { commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [{ ...check(1), status: 'COMPLETED' }] } } } }] } })]));
    listOpenPrsLightPaged({ repo, exec: done, pageSize: 20 });
    expect(done).toHaveBeenCalledTimes(1);
  });
  it('reaches the 21st pending external check on a fresh snapshot without exceeding 20 REST lookups', () => {
    const ids = Array.from({ length: 21 }, (_, i) => 777 + i);
    let lookedUp = [];
    const exec = vi.fn((_file, args) => {
      if (args[1] === 'graphql') {
        return args[3].includes('after:') ? page(externalNodes(ids.slice(20)), false, null, 21)
          : page(externalNodes(ids.slice(0, 20)), true, 'next', 21);
      }
      lookedUp.push(Number(args[1].split('/').at(-1)));
      return JSON.stringify({ app: { id: 5037855, slug: 'web-everything' } });
    });
    const read = () => listOpenPrsLightPaged({ repo: 'starvation/success', exec, pageSize: 20 });
    const first = read();
    expect(lookedUp).toEqual(ids.slice(0, 20));
    expect(first.rows.at(-1).statusCheckRollup[0].appId).toBeNull();
    lookedUp = [];
    const second = read();
    expect(lookedUp).toHaveLength(1);
    expect(lookedUp[0]).toBe(797);
    expect(second.rows.at(-1).statusCheckRollup[0]).toMatchObject({ appId: 5037855, appSlug: 'web-everything' });
  });
  it('rotates past failed and malformed app reads while unknown checks stay closed', () => {
    const ids = Array.from({ length: 41 }, (_, i) => 1000 + i);
    const attempted = new Set();
    let calls = 0;
    const exec = vi.fn((_file, args) => {
      if (args[1] === 'graphql') return page(externalNodes(ids), false, null, 41);
      calls++;
      const id = Number(args[1].split('/').at(-1));
      attempted.add(id);
      if (id % 2) throw new Error('unreadable');
      return '{"app":null}';
    });
    for (let refresh = 0; refresh < 3; refresh++) {
      calls = 0;
      const result = listOpenPrsLightPaged({ repo: 'starvation/failure', exec, pageSize: 100 });
      expect(calls).toBe(20);
      expect(result.rows.every(r => r.statusCheckRollup[0].appId === null)).toBe(true);
    }
    expect([...attempted].sort((a, b) => a - b)).toEqual(ids);
  });
  it('keeps lookup progress per repository and handles changed or empty candidate lists', () => {
    let ids = Array.from({ length: 21 }, (_, i) => 2000 + i);
    let lookedUp = [];
    const exec = vi.fn((_file, args) => {
      if (args[1] === 'graphql') return page(externalNodes(ids), false, null, ids.length);
      lookedUp.push(Number(args[1].split('/').at(-1)));
      return '{"app":{"id":42,"slug":"other-app"}}';
    });
    const read = repo => listOpenPrsLightPaged({ repo, exec, pageSize: 100 });
    read('starvation/one');
    lookedUp = [];
    read('starvation/two');
    expect(lookedUp[0]).toBe(2000);
    // A new check at the front does not reset progress past the previous last attempt.
    ids.unshift(1999);
    lookedUp = [];
    read('starvation/one');
    expect(lookedUp[0]).toBe(2020);
    expect(lookedUp).toEqual([2020, 1999]);
    // The cursor can disappear, and no candidates is also a valid snapshot.
    ids = [3000];
    lookedUp = [];
    read('starvation/one');
    expect(lookedUp).toEqual([3000]);
    ids = [];
    lookedUp = [];
    expect(read('starvation/one').rows).toEqual([]);
    expect(lookedUp).toEqual([]);
  });
  it('deduplicates shared-head check IDs and supplies provenance to every PR copy', () => {
    const nodes = [...externalNodes(Array(21).fill(4000)), ...externalNodes([4001])]
      .map((n, i) => ({ ...n, number: i + 1 }));
    let calls = 0;
    const exec = vi.fn((_file, args) => {
      if (args[1] === 'graphql') return page(nodes, false, null, nodes.length);
      calls++;
      return '{"app":{"id":42,"slug":"poster"}}';
    });
    const result = listOpenPrsLightPaged({ repo: 'starvation/duplicates', exec, pageSize: 100 });
    expect(calls).toBe(2);
    expect(result.rows.every(r => r.statusCheckRollup[0].appId === 42)).toBe(true);
  });
  it('accumulates provenance when one PR has more than 20 pending external checks', () => {
    const ids = Array.from({ length: 41 }, (_, i) => 5000 + i);
    const checks = externalNodes(ids).flatMap(n => n.commits.nodes[0].commit.statusCheckRollup.contexts.nodes);
    const n = node(1, { commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: checks } } } }] } });
    let calls = 0;
    const exec = vi.fn((_file, args) => {
      if (args[1] === 'graphql') return page([n], false, null, 1);
      calls++;
      return '{"app":{"id":5037855,"slug":"web-everything"}}';
    });
    for (const [expectedCalls, resolved] of [[20, 20], [20, 40], [1, 41]]) {
      calls = 0;
      const { rows } = listOpenPrsLightPaged({ repo: 'starvation/many-checks', exec, pageSize: 100 });
      expect(calls).toBe(expectedCalls);
      expect(rows[0].statusCheckRollup.filter(c => c.appId === 5037855)).toHaveLength(resolved);
    }
  });
  it('evicts old repository lookup state with fresh reads as the fallback', () => {
    let calls = 0;
    const exec = vi.fn((_file, args) => {
      if (args[1] === 'graphql') return page(externalNodes([6000]), false, null, 1);
      calls++;
      return '{"app":{"id":42,"slug":"poster"}}';
    });
    for (let i = 0; i <= 128; i++) listOpenPrsLightPaged({ repo: `eviction/repo-${i}`, exec, pageSize: 100 });
    calls = 0;
    const { rows } = listOpenPrsLightPaged({ repo: 'eviction/repo-0', exec, pageSize: 100 });
    expect(calls).toBe(1);
    expect(rows[0].statusCheckRollup[0].appId).toBe(42);
  });
  it('binds persisted app provenance to the repository and current check ID', () => {
    const state = { repo: 'provenance/old', cursor: 7000, apps: { 7000: { appId: 42, appSlug: 'old-app' } } };
    let ids = [7000];
    const exec = vi.fn((_file, args) => {
      if (args[1] === 'graphql') return page(externalNodes(ids), false, null, ids.length);
      throw new Error('unreadable');
    });
    const read = () => listOpenPrsLightPaged({ repo: 'provenance/new', exec, pageSize: 100, checkAppState: state });
    expect(read().rows[0].statusCheckRollup[0].appId).toBeNull();
    expect(state.apps).toEqual({});
    state.apps[7000] = { appId: 42, appSlug: 'old-app' };
    ids = [7001];
    expect(read().rows[0].statusCheckRollup[0].appId).toBeNull();
    expect(state.apps).toEqual({});
  });
  it('continues past a removed cursor after serializing failed lookup progress', () => {
    const ids = Array.from({ length: 41 }, (_, i) => 8000 + i);
    let state = {};
    let lookedUp = [];
    const exec = vi.fn((_file, args) => {
      if (args[1] === 'graphql') return page(externalNodes(ids), false, null, ids.length);
      lookedUp.push(Number(args[1].split('/').at(-1)));
      throw new Error('unreadable');
    });
    const read = () => listOpenPrsLightPaged({ repo: 'starvation/removed-cursor', exec, pageSize: 100, checkAppState: state });
    read();
    expect(lookedUp).toEqual(ids.slice(0, 20));
    state = JSON.parse(JSON.stringify(state));
    ids.splice(19, 1);
    lookedUp = [];
    read();
    expect(lookedUp).toEqual(Array.from({ length: 20 }, (_, i) => 8020 + i));
    expect(state.apps).toEqual({});
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
    expect(exec.mock.calls[0][2]).toEqual({ ...opts, timeout: 123, env: expect.objectContaining({ GH_REPO: repo }) });
  });
  it('names the target repo in GH_REPO on top of a caller env', () => {
    const exec = vi.fn(() => page([node(1)]));
    listOpenPrsLightPaged({ repo, exec, pageSize: 2, execOpts: { env: { KEEP: '1' } } });
    expect(exec.mock.calls[0][2].env).toEqual({ KEEP: '1', GH_REPO: repo });
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

describe('inventory completeness (fewer rows than GitHub reported is never a complete list)', () => {
  const emptyPage = (totalCount) => () => JSON.stringify({ data: { repository: { pullRequests: { nodes: [], totalCount,
    pageInfo: { hasNextPage: false, endCursor: null } } } } });
  it('assertInventoryComplete names the shortfall and passes complete or truncated-declared lists', () => {
    expect(() => assertInventoryComplete({ repo: 'owner/name', rows: [], totalCount: 7 })).toThrow(PrListUnreadableError);
    expect(() => assertInventoryComplete({ repo: 'owner/name', rows: [], totalCount: 7 })).toThrow(/0 of 7/);
    expect(() => assertInventoryComplete({ repo: 'owner/name', rows: [{ number: 1 }], totalCount: 1 })).not.toThrow();
    expect(() => assertInventoryComplete({ repo: 'owner/name', rows: [], totalCount: 7, truncated: true })).not.toThrow();
    expect(() => assertInventoryComplete({ repo: 'owner/name', rows: [], totalCount: undefined })).not.toThrow();
  });
  it('the drain-facing listing refuses a short inventory instead of returning it', () => {
    const paging = { pageSize: 20, pageRetries: 0, heavyMaxAgeSeconds: 600 };
    expect(() => listOpenPrsPagedHydratedComplete({ repo: 'owner/name', exec: emptyPage(7), paging, heavyFields: [] }))
      .toThrow(/0 of 7/);
    expect(listOpenPrsPagedHydratedComplete({ repo: 'owner/name', exec: emptyPage(0), paging, heavyFields: [] }).rows).toEqual([]);
  });
});

describe('fail-closed list parsing and uniqueness (one class: a list read must never look complete when it is not)', () => {
  it('duplicate PR numbers cannot hide an omitted PR: unique rows are counted against totalCount', () => {
    const dup = [{ number: 1 }, { number: 1 }];
    expect(() => assertInventoryComplete({ repo: 'owner/name', rows: dup, totalCount: 2 })).toThrow(/1 unique of 2|duplicate/);
    expect(() => assertInventoryComplete({ repo: 'owner/name', rows: [{ number: 1 }, { number: 2 }], totalCount: 2 })).not.toThrow();
  });
  it('a row whose PR number is not a positive integer fails the read closed (no raw-count fallback)', () => {
    for (const bad of [[{ number: 1 }, { number: 1 }, {}], [{ number: 1 }, { number: 'x' }], [{ number: 0 }], [{ number: -2 }], [null], [{ number: 1.5 }]]) {
      expect(() => assertInventoryComplete({ repo: 'owner/name', rows: bad, totalCount: bad.length })).toThrow(/malformed|positive integer/);
    }
  });
  it('parseListOutput: empty/blank output, non-JSON and non-array JSON throw; a real empty list is fine', () => {
    for (const bad of ['', '   \n', undefined, null, '{"message":"oops"}', 'not json']) {
      expect(() => parseListOutput(bad, { repo: 'owner/name' })).toThrow();
    }
    expect(parseListOutput('[]', { repo: 'owner/name' })).toEqual([]);
    expect(parseListOutput(Buffer.from('[{"number":1}]'), { repo: 'owner/name' })).toEqual([{ number: 1 }]);
  });
});

it('preserves the commit read head when the PR head is newer', async () => {
  const { resolveRequiredChecks } = await import('../check-state-predicate.mjs');
  const current = 'a'.repeat(40), readHead = 'b'.repeat(40);
  const pr = mapGraphqlPr({ headRefOid: current, commits: { nodes: [{ commit: { oid: readHead,
    statusCheckRollup: { contexts: { pageInfo: { hasNextPage: false }, totalCount: 1,
      nodes: [{ __typename: 'StatusContext', context: 'test', state: 'SUCCESS' }] } } } }] } });
  expect(pr).toMatchObject({ headRefOid: current, rowsHead: readHead, rowsComplete: true });
  expect(resolveRequiredChecks({ head: pr.headRefOid, rowsHead: pr.rowsHead, rowsComplete: pr.rowsComplete,
    rows: pr.statusCheckRollup, requiredNames: ['test'], rosterSource: 'live' }))
    .toMatchObject({ state: 'unknown', reasons: ['foreign-head'] });
});


it.each([null, {}, { __typename: 'Unexpected', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }])(
  'malformed GraphQL node %j marks connection evidence incomplete', malformed => {
    const head = 'a'.repeat(40);
    const success = { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' };
    for (const nodes of [[success, malformed], [malformed, success]]) {
      const commit = { oid: head,
        statusCheckRollup: { contexts: { pageInfo: { hasNextPage: false }, totalCount: 2, nodes } } };
      expect(rollupEvidence(commit)).toEqual({ rowsHead: head, rowsComplete: false });
      if (malformed === null) {
        // Preserve main's mapping error for null nodes.
        expect(() => mapGraphqlPr({ commits: { nodes: [{ commit }] } })).toThrow(TypeError);
      } else {
        const pr = mapGraphqlPr({ commits: { nodes: [{ commit }] } });
        expect(pr.rowsComplete).toBe(false);
        expect(pr.statusCheckRollup).toEqual(nodes.map(n => n === success
          ? { __typename: 'CheckRun', completedAt: '0001-01-01T00:00:00Z', conclusion: 'SUCCESS',
            detailsUrl: undefined, name: 'test', startedAt: '0001-01-01T00:00:00Z', status: 'COMPLETED',
            workflowName: '', appSlug: '', appId: null }
          : { __typename: 'StatusContext', context: undefined, startedAt: undefined, state: undefined, targetUrl: '' }));
      }
    }
  });
