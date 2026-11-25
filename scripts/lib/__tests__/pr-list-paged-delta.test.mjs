/**
 * @file scripts/lib/__tests__/pr-list-paged-delta.test.mjs
 * @description DRAIN-LIST-DELTA: per-field heavy validators (SHIP-API-004), candidate-always-fresh, backstop setting.
 */
import { describe, it, expect } from 'vitest';
import { listOpenPrsPagedHydrated, HEAVY_VALIDATORS, PrListUnreadableError, resolvePrListPaging } from '../pr-list-paged.mjs';

const repo = 'owner/name';
const baseNode = (number, extra = {}) => ({ number, title: `PR ${number}`, url: `https://example.com/${number}`,
  isDraft: false, createdAt: '2026-10-12T00:00:00Z', updatedAt: '2026-10-13T00:00:00Z',
  headRefName: `branch-${number}`, headRefOid: `head-${number}`, baseRefName: 'main',
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
    expect(HEAVY_VALIDATORS.files).toEqual(['headRefOid', 'baseRefName']);
    expect(HEAVY_VALIDATORS.body).toEqual(['updatedAt']);
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
    state.nodes = [baseNode(1, { baseRefName: 'release', headRefOid: 'other' })];
    run(state, { cache: second.cache, nowMs: 1_002_000 });
    expect(state.views).toEqual([{ number: 1, fields: ['files'] }]);
  });

  it('an unchanged non-candidate is not re-read after 600 s within the backstop', () => {
    const state = { nodes: [baseNode(1)], views: [] };
    const first = run(state);
    state.views.length = 0;
    const second = run(state, { cache: first.cache, nowMs: 1_000_000 + 700_000 });
    expect(state.views).toEqual([]);
    expect(second.stats.reused).toBe(1);
    expect(second.rows[0].body).toBe('body-0');
  });

  it('past the backstop an unchanged non-candidate is re-read', () => {
    const state = { nodes: [baseNode(1)], views: [] };
    const first = run(state);
    state.views.length = 0;
    const second = run(state, { cache: first.cache, nowMs: 1_000_000 + 3_700_000 });
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
    const state = { nodes: [baseNode(1, { mergeStateStatus: 'BLOCKED' })], views: [] };
    const seed = [{ number: 1, updatedAt: '2026-10-13T00:00:00Z', headRefOid: 'head-1', baseRefName: 'main', heavyFetchedAtMs: 999_000, body: 'seedbody', files: [],
      statusCheckRollup: [{ name: 'x', conclusion: 'SUCCESS', foreignApp: 1 }], mergeStateStatus: 'CLEAN' }];
    const out = run(state, { seed, isCandidate: () => false });
    expect(out.rows[0].mergeStateStatus).toBe('BLOCKED');
    expect(out.rows[0].statusCheckRollup).not.toEqual(seed[0].statusCheckRollup);
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
    heavyFetchedAtMs: 999_000, body: 'seedbody', files: [{ path: 's' }], ...extra });
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
