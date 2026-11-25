/**
 * @file scripts/lib/__tests__/pr-list-paged-delta.test.mjs
 * @description DRAIN-LIST-DELTA: per-field heavy validators (SHIP-API-004), candidate-always-fresh, backstop setting.
 */
import { describe, it, expect } from 'vitest';
import { listOpenPrsPagedHydrated, HEAVY_VALIDATORS, PrListUnreadableError, resolvePrListPaging } from '../pr-list-paged.mjs';

const repo = 'owner/name';
const baseNode = (number, extra = {}) => ({ number, title: `PR ${number}`, url: `https://example.com/${number}`,
  isDraft: false, createdAt: '2026-10-12T00:00:00Z', updatedAt: '2026-10-13T00:00:00Z',
  headRefName: `branch-${number}`, headRefOid: `head-${number}`, baseRefName: 'main', baseRefOid: 'base-oid',
  isCrossRepository: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: null, ...extra });

/** A fake gh: `state.nodes` is the live page; `state.views` logs the --json field list of every `pr view`. */
function fakeGh(state) {
  return (_cmd, args) => {
    if (args[0] === 'api') {
      return JSON.stringify({ data: { repository: { pullRequests: { nodes: state.nodes,
        pageInfo: { hasNextPage: false, endCursor: null }, totalCount: state.nodes.length } } } });
    }
    if (state.failView) throw new Error('boom');
    const fields = args[args.indexOf('--json') + 1].split(',');
    state.views.push({ number: Number(args[2]), fields });
    return JSON.stringify(Object.fromEntries(fields.map(f => [f, f === 'files' ? [{ path: `f-${state.tag ?? 0}` }] : `${f}-${state.tag ?? 0}`])));
  };
}
const paging = (extra = {}) => ({ pageSize: 20, pageRetries: 0, heavyMaxAgeSeconds: 600, heavyBackstopSeconds: 3600, ...extra });
const run = (state, o = {}) => listOpenPrsPagedHydrated({ repo, exec: fakeGh(state), paging: paging(o.paging),
  heavyFields: ['body', 'files'], delta: { isCandidate: o.isCandidate ?? (() => false) },
  cache: o.cache ?? {}, nowMs: o.nowMs ?? 1_000_000, seed: o.seed ?? [] });

describe('DRAIN-LIST-DELTA', () => {
  it('declares per-field validators', () => {
    expect(HEAVY_VALIDATORS.files).toEqual(['headRefOid', 'baseRefName', 'baseRefOid']);
    expect(HEAVY_VALIDATORS.body).toEqual(['updatedAt', 'headRefOid']);
    expect(HEAVY_VALIDATORS.comments).toEqual(['updatedAt', 'headRefOid']);
  });

  it('a label-only change re-reads body but reuses files', () => {
    const state = { nodes: [baseNode(1)], views: [] };
    const first = run(state);
    state.views.length = 0;
    state.nodes = [baseNode(1, { updatedAt: '2026-10-14T00:00:00Z' })];
    state.tag = 1;
    const second = run(state, { cache: first.cache, nowMs: 1_001_000 });
    expect(state.views).toEqual([{ number: 1, fields: ['body'] }]);
    expect(second.rows[0].body).toBe('body-1');
    expect(second.rows[0].files).toEqual([{ path: 'f-0' }]);
    expect(second.stats.byReason.updatedAt).toBe(1);
  });

  it('a head or base change re-reads files only', () => {
    const state = { nodes: [baseNode(1)], views: [] };
    const first = run(state);
    state.views.length = 0;
    state.nodes = [baseNode(1, { baseRefName: 'release' })];
    const second = run(state, { cache: first.cache, nowMs: 1_001_000 });
    expect(state.views).toEqual([{ number: 1, fields: ['files'] }]);
    expect(second.stats.byReason.base).toBe(1);
    state.views.length = 0;
    // A head change invalidates both: files by head, body by updatedAt AND head.
    state.nodes = [baseNode(1, { baseRefName: 'release', headRefOid: 'other' })];
    run(state, { cache: second.cache, nowMs: 1_002_000 });
    expect(state.views).toEqual([{ number: 1, fields: ['body', 'files'] }]);
  });

  it('a base tip move (same base branch name) re-reads files only', () => {
    const state = { nodes: [baseNode(1)], views: [] };
    const first = run(state);
    state.views.length = 0;
    state.nodes = [baseNode(1, { baseRefOid: 'moved' })];
    const second = run(state, { cache: first.cache, nowMs: 1_001_000 });
    expect(state.views).toEqual([{ number: 1, fields: ['files'] }]);
    expect(second.stats.byReason.base).toBe(1);
  });

  it('a head change with an unchanged updatedAt re-reads the body', () => {
    const state = { nodes: [baseNode(1)], views: [] };
    const first = run(state);
    state.views.length = 0;
    state.nodes = [baseNode(1, { headRefOid: 'new-head' })];
    run(state, { cache: first.cache, nowMs: 1_001_000 });
    expect(state.views).toEqual([{ number: 1, fields: ['body', 'files'] }]);
  });

  it('delta mode without an isCandidate predicate throws, never defaults to false', () => {
    const state = { nodes: [baseNode(1)], views: [] };
    expect(() => listOpenPrsPagedHydrated({ repo, exec: fakeGh(state), paging: paging(), heavyFields: ['body', 'files'],
      delta: {}, cache: {}, nowMs: 1_000_000, seed: [] })).toThrow(/isCandidate/);
  });

  it('heavyMaxAgeSeconds is an upper bound in delta mode, even with a longer backstop', () => {
    const state = { nodes: [baseNode(1)], views: [] };
    const first = run(state);
    state.views.length = 0;
    run(state, { cache: first.cache, nowMs: 1_000_000 + 700_000 });
    expect(state.views).toEqual([{ number: 1, fields: ['body', 'files'] }]);
  });

  it('an unchanged non-candidate is not re-read within the age bound', () => {
    const state = { nodes: [baseNode(1)], views: [] };
    const first = run(state);
    state.views.length = 0;
    const second = run(state, { cache: first.cache, nowMs: 1_000_000 + 500_000 });
    expect(state.views).toEqual([]);
    expect(second.stats.reused).toBe(1);
    expect(second.rows[0].body).toBe('body-0');
  });

  it('a tighter backstop (300 s) is enforced below the 600 s age limit', () => {
    const state = { nodes: [baseNode(1)], views: [] };
    const tight = { paging: { heavyBackstopSeconds: 300 } };
    const first = run(state, tight);
    state.views.length = 0;
    run(state, { ...tight, cache: first.cache, nowMs: 1_000_000 + 200_000 });
    expect(state.views).toEqual([]);
    const second = run(state, { ...tight, cache: first.cache, nowMs: 1_000_000 + 400_000 });
    expect(state.views).toEqual([{ number: 1, fields: ['body', 'files'] }]);
    expect(second.stats.byReason.backstop).toBe(2);
  });

  it('a ready candidate is always re-read', () => {
    const state = { nodes: [baseNode(1)], views: [] };
    const first = run(state);
    state.views.length = 0;
    const second = run(state, { cache: first.cache, nowMs: 1_001_000, isCandidate: () => true });
    expect(state.views).toEqual([{ number: 1, fields: ['body', 'files'] }]);
    expect(second.stats.candidates).toBe(1);
    expect(second.stats.byReason.candidate).toBe(2);
  });

  it('a missing heavyBackstopSeconds setting re-reads (closed outcome)', () => {
    const state = { nodes: [baseNode(1)], views: [] };
    const first = run(state, { paging: { heavyBackstopSeconds: undefined } });
    state.views.length = 0;
    run(state, { cache: first.cache, nowMs: 1_001_000, paging: { heavyBackstopSeconds: undefined } });
    expect(state.views).toEqual([{ number: 1, fields: ['body', 'files'] }]);
  });

  it('an older updatedAt still re-reads (equality, never ordering)', () => {
    const state = { nodes: [baseNode(1)], views: [] };
    const first = run(state);
    state.views.length = 0;
    state.nodes = [baseNode(1, { updatedAt: '2026-10-01T00:00:00Z' })];
    run(state, { cache: first.cache, nowMs: 1_001_000 });
    expect(state.views).toEqual([{ number: 1, fields: ['body'] }]);
  });

  it('same head, changed check result: gate fields come from the live page, never the seed or cache', () => {
    const live = { commits: { nodes: [{ commit: { oid: 'a'.repeat(40), statusCheckRollup: { contexts: {
      pageInfo: { hasNextPage: false }, totalCount: 1, nodes: [{ __typename: 'StatusContext', context: 'live-ci', state: 'FAILURE' }] } } } }] } };
    const state = { nodes: [baseNode(1, { mergeStateStatus: 'BLOCKED', ...live })], views: [] };
    const seed = [{ number: 1, updatedAt: '2026-10-13T00:00:00Z', headRefOid: 'head-1', baseRefName: 'main', baseRefOid: 'base-oid',
      heavyFetchedAtMs: 999_000, body: 'seedbody', files: [],
      statusCheckRollup: [{ name: 'x', conclusion: 'SUCCESS', foreignApp: 1 }], mergeStateStatus: 'CLEAN' }];
    const out = run(state, { seed, isCandidate: () => false });
    expect(out.rows[0].mergeStateStatus).toBe('BLOCKED');
    expect(out.rows[0].statusCheckRollup).toHaveLength(1);
    expect(JSON.stringify(out.rows[0].statusCheckRollup)).toContain('live-ci');
    expect(JSON.stringify(out.rows[0].statusCheckRollup)).toContain('FAILURE');
    expect(out.rows[0].rowsComplete).toBe(true);
    expect(out.cache[1].statusCheckRollup).toBeUndefined();
    expect(out.rows[0].body).toBe('seedbody');
    expect(state.views).toEqual([]);
  });

  it('a hydrate failure throws unreadable, never partial', () => {
    const state = { nodes: [baseNode(1)], views: [], failView: true };
    expect(() => run(state)).toThrow(PrListUnreadableError);
  });

  it('prunes closed PRs and re-reads a reopened one', () => {
    const state = { nodes: [baseNode(1), baseNode(2)], views: [] };
    const first = run(state);
    state.nodes = [baseNode(2)];
    const second = run(state, { cache: first.cache, nowMs: 1_001_000 });
    expect(Object.keys(second.cache)).toEqual(['2']);
    state.views.length = 0;
    state.nodes = [baseNode(1), baseNode(2)];
    run(state, { cache: second.cache, nowMs: 1_002_000 });
    expect(state.views).toEqual([{ number: 1, fields: ['body', 'files'] }]);
  });

  it('reports split timings and the backstop setting has no code default', () => {
    const state = { nodes: [baseNode(1)], views: [] };
    const out = run(state);
    expect(out.timing).toEqual({ lightMs: expect.any(Number), hydrateMs: expect.any(Number) });
    expect(resolvePrListPaging({ env: {}, file: {} }).heavyBackstopSeconds).toBeUndefined();
  });
});

describe('DRAIN-LIST-DELTA call sites', () => {
  it('both drain listing call sites use the delta predicate, not a forced hydrate-all', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('scripts/merge-ai-prs.mjs', 'utf8');
    expect(src.match(/delta: \{ isCandidate: operatorSelects \}/g)).toHaveLength(2);
    expect(src).not.toMatch(/needsHeavy: RECONCILE \? \(\) => true/);
  });
});

describe('DRAIN-LIST-DELTA audit hardening', () => {
  const seedRow = (extra = {}) => ({ number: 1, updatedAt: '2026-10-13T00:00:00Z', headRefOid: 'head-1', baseRefName: 'main',
    baseRefOid: 'base-oid', heavyFetchedAtMs: 999_000, body: 'seedbody', files: [{ path: 's' }], ...extra });
  it('a seed with the wrong base or no retrieval time is ignored for files', () => {
    for (const extra of [{ baseRefName: 'release' }, { heavyFetchedAtMs: undefined }]) {
      const state = { nodes: [baseNode(1)], views: [] };
      run(state, { seed: [seedRow(extra)] });
      expect(state.views.some(v => v.fields.includes('files'))).toBe(true);
    }
  });
  it('a seed keeps its real age: an old seed past the backstop is re-read', () => {
    const state = { nodes: [baseNode(1)], views: [] };
    run(state, { seed: [seedRow({ heavyFetchedAtMs: 1_000_000 - 4_000_000 })] });
    expect(state.views).toEqual([{ number: 1, fields: ['body', 'files'] }]);
  });
  it('missing validators and future timestamps fail closed', () => {
    const state = { nodes: [baseNode(1, { headRefOid: undefined })], views: [] };
    const first = run(state);
    state.views.length = 0;
    run(state, { cache: first.cache, nowMs: 1_001_000 });
    expect(state.views.some(v => v.fields.includes('files'))).toBe(true);
    const s2 = { nodes: [baseNode(2)], views: [] };
    const f2 = run(s2, { nowMs: 5_000_000 });
    s2.views.length = 0;
    run(s2, { cache: f2.cache, nowMs: 1_000_000 });
    expect(s2.views).toEqual([{ number: 2, fields: ['body', 'files'] }]);
  });
  it('malformed heavy data (null body or files) is unreadable', () => {
    const exec = (_c, args) => args[0] === 'api'
      ? JSON.stringify({ data: { repository: { pullRequests: { nodes: [baseNode(1)], pageInfo: { hasNextPage: false, endCursor: null }, totalCount: 1 } } } })
      : JSON.stringify({ body: null, files: null });
    expect(() => listOpenPrsPagedHydrated({ repo, exec, paging: paging(), heavyFields: ['body', 'files'],
      delta: { isCandidate: () => false }, cache: {}, nowMs: 1_000_000, seed: [] })).toThrow(PrListUnreadableError);
  });
});

describe('DRAIN-LIST-DELTA round 3', () => {
  const seedRow = (extra = {}) => ({ number: 1, updatedAt: '2026-10-13T00:00:00Z', headRefOid: 'head-1', baseRefName: 'main',
    baseRefOid: 'base-oid', heavyFetchedAtMs: 999_000, body: 'seedbody', files: [{ path: 's }' }], ...extra });
  it('a seed with null body or files is re-read, like readHeavy', () => {
    for (const extra of [{ body: null }, { files: null }]) {
      const state = { nodes: [baseNode(1)], views: [] };
      const out = run(state, { seed: [seedRow(extra)] });
      expect(state.views.length).toBe(1);
      expect(typeof out.rows[0].body).toBe('string');
      expect(Array.isArray(out.rows[0].files)).toBe(true);
    }
  });
  it('a valid seed under matching validators is used without a read', () => {
    const state = { nodes: [baseNode(1)], views: [] };
    const out = run(state, { seed: [seedRow()] });
    expect(state.views).toEqual([]);
    expect(out.rows[0].body).toBe('seedbody');
  });
  it('the async drain entry executes the delta path: candidates re-read, others reused', async () => {
    const { listOpenPrsPagedHydratedCompleteAsync } = await import('../pr-list-paged.mjs');
    const state = { nodes: [baseNode(1), baseNode(2)], views: [] };
    const exec = fakeGh(state);
    const execAsync = async (...a) => ({ stdout: exec(...a) });
    const call = (cache, nowMs) => listOpenPrsPagedHydratedCompleteAsync({ repo, exec, execAsync, paging: paging(),
      heavyFields: ['body', 'files'], delta: { isCandidate: r => r.number === 2 }, cache, nowMs, seed: [] });
    const first = await call({}, 1_000_000);
    state.views.length = 0;
    const second = await call(first.cache, 1_001_000);
    expect(state.views).toEqual([{ number: 2, fields: ['body', 'files'] }]);
    expect(second.stats.reused).toBe(1);
    expect(second.stats.candidates).toBe(1);
  });
});

describe('DRAIN-LIST-DELTA round 4: direct hydrator callers', () => {
  const row1 = { number: 1, updatedAt: 'u', headRefOid: 'h', baseRefName: 'main', baseRefOid: 'b' };
  const exec = () => JSON.stringify({ body: 'fresh', files: [] });
  const entry = (extra = {}) => ({ body: 'old', files: [], stamps: {
    body: { updatedAt: 'u', headRefOid: 'h', fetchedAtMs: 1000 },
    files: { headRefOid: 'h', baseRefName: 'main', baseRefOid: 'b', fetchedAtMs: 1000 } }, ...extra });
  it('both hydrators throw on a missing isCandidate in delta mode', async () => {
    const { hydrateHeavyFields, hydrateHeavyFieldsAsync } = await import('../pr-list-paged.mjs');
    expect(() => hydrateHeavyFields({ repo, rows: [row1], exec, fields: ['body', 'files'], delta: { backstopMs: 1e6 } }))
      .toThrow(/isCandidate/);
    await expect(hydrateHeavyFieldsAsync({ repo, rows: [row1], execAsync: async () => ({ stdout: exec() }),
      fields: ['body', 'files'], delta: { backstopMs: 1e6 } })).rejects.toThrow(/isCandidate/);
  });
  it('delta hydration honours maxAgeMs as an upper bound over a longer backstop', async () => {
    const { hydrateHeavyFields } = await import('../pr-list-paged.mjs');
    const out = hydrateHeavyFields({ repo, rows: [row1], exec, fields: ['body', 'files'], nowMs: 1000 + 700_000, maxAgeMs: 600_000,
      cache: { 1: entry() }, delta: { isCandidate: () => false, backstopMs: 3_600_000 } });
    expect(out.fetched).toBe(1);
    expect(out.rows[0].body).toBe('fresh');
  });
  it('an invalid cached value (stamped body null) is re-read, not reused', async () => {
    const { hydrateHeavyFields } = await import('../pr-list-paged.mjs');
    const out = hydrateHeavyFields({ repo, rows: [row1], exec, fields: ['body', 'files'], nowMs: 2000,
      cache: { 1: entry({ body: null }) }, delta: { isCandidate: () => false, backstopMs: 3_600_000 } });
    expect(out.rows[0].body).toBe('fresh');
    expect(out.stats.byReason.new).toBe(1);
  });
});

describe('DRAIN-LIST-DELTA round 5', () => {
  it('delta.maxAgeMs only tightens the caller maxAgeMs, never widens it', async () => {
    const { hydrateHeavyFields } = await import('../pr-list-paged.mjs');
    const row1 = { number: 1, updatedAt: 'u', headRefOid: 'h', baseRefName: 'main', baseRefOid: 'b' };
    const cache = { 1: { body: 'old', files: [], stamps: {
      body: { updatedAt: 'u', headRefOid: 'h', fetchedAtMs: 1000 },
      files: { headRefOid: 'h', baseRefName: 'main', baseRefOid: 'b', fetchedAtMs: 1000 } } } };
    const out = hydrateHeavyFields({ repo, rows: [row1], exec: () => JSON.stringify({ body: 'fresh', files: [] }),
      fields: ['body', 'files'], nowMs: 1000 + 700_000, maxAgeMs: 600_000, cache,
      delta: { isCandidate: () => false, backstopMs: 3_600_000, maxAgeMs: 900_000 } });
    expect(out.rows[0].body).toBe('fresh');
  });
});

describe('DRAIN-LIST-DELTA round 6', () => {
  it('a non-finite maxAgeMs (NaN) forces a read, never a silent drop', async () => {
    const { hydrateHeavyFields } = await import('../pr-list-paged.mjs');
    const row1 = { number: 1, updatedAt: 'u', headRefOid: 'h', baseRefName: 'main', baseRefOid: 'b' };
    const cache = { 1: { body: 'old', files: [], stamps: {
      body: { updatedAt: 'u', headRefOid: 'h', fetchedAtMs: 1000 },
      files: { headRefOid: 'h', baseRefName: 'main', baseRefOid: 'b', fetchedAtMs: 1000 } } } };
    for (const [maxAgeMs, dm] of [[NaN, undefined], [600_000, NaN]]) {
      const out = hydrateHeavyFields({ repo, rows: [row1], exec: () => JSON.stringify({ body: 'fresh', files: [] }),
        fields: ['body', 'files'], nowMs: 2000, maxAgeMs, cache,
        delta: { isCandidate: () => false, backstopMs: 3_600_000, maxAgeMs: dm } });
      expect(out.rows[0].body).toBe('fresh');
    }
  });
});
