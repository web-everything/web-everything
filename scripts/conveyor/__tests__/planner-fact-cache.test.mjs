import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  prFactKey, mainFactKey, createPlannerFactCache, readThroughShadow,
} from '../planner-fact-cache.mjs';
import { defaultReadPrs } from '../reconcile-pass.mjs';
import { markHungSessions, planReconcile } from '../reconcile-core.mjs';
import { classifyHungSession } from '../hung-session.mjs';

vi.mock('../../lib/review-facts.mjs', async original => ({
  ...await original(), warmReviewFacts: async () => ({ skipped: 'test' }),
}));

const REPO = 'org/repo';
const START = Date.parse('2026-10-01T00:00:00Z');
const HOUR = 60 * 60 * 1000;
const fact = (overrides = {}) => ({
  repo: REPO, number: 5, state: 'OPEN',
  headRefName: 'lane/fact-cache', headRefOid: 'a'.repeat(40),
  baseRefName: 'main', baseSha: 'b'.repeat(40),
  labels: [{ name: 'checking' }, { name: 'automation' }],
  mergeStateStatus: 'CLEAN', comments: [],
  statusCheckRollup: [
    { name: 'gate', status: 'COMPLETED', conclusion: 'SUCCESS', completedAt: '2026-10-01T00:00:00Z' },
    { name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS', completedAt: '2026-10-01T00:01:00Z' },
  ],
  ...overrides,
});

function harness(options = {}) {
  let time = START;
  const cache = createPlannerFactCache({ now: () => time, ...options });
  return { cache, setNow: value => { time = value; } };
}

// Snapshot IO stays in memory; production fs is never used for persistence.
function memoryFs() {
  const files = new Map();
  return {
    files,
    readFile: vi.fn(path => {
      if (!files.has(path)) throw new Error('ENOENT');
      return files.get(path);
    }),
    writeFile: vi.fn((path, data) => { files.set(path, String(data)); }),
  };
}

describe('planner fact identity', () => {
  it.each([
    ['repo', { repo: 'org/other' }],
    ['number', { number: 6 }],
    ['head', { headRefOid: 'c'.repeat(40) }],
    ['base SHA', { baseSha: 'd'.repeat(40) }],
    ['one label', { labels: [{ name: 'checking' }, { name: 'changed' }] }],
  ])('changes the key when %s changes', (_name, change) => {
    expect(typeof prFactKey(fact())).toBe('string');
    expect(prFactKey(fact(change))).not.toBe(prFactKey(fact()));
  });

  it.each([
    ['name', 'other-gate'], ['status', 'IN_PROGRESS'],
    ['conclusion', 'FAILURE'], ['completedAt', '2026-10-01T00:02:00Z'],
  ])('hashes check-run %s into the key', (field, value) => {
    const row = fact();
    const changed = { ...row, statusCheckRollup: row.statusCheckRollup.map((check, i) =>
      i === 0 ? { ...check, [field]: value } : check) };
    expect(prFactKey(changed)).not.toBe(prFactKey(row));
  });

  it('uses a sorted label-name set and order-independent check-run state', () => {
    const row = fact();
    expect(prFactKey({ ...row,
      labels: [{ name: 'automation' }, { name: 'checking' }, { name: 'automation' }],
      statusCheckRollup: [...row.statusCheckRollup].reverse(),
    })).toBe(prFactKey(row));
    expect(prFactKey({ ...row, labels: ['automation', 'checking'] })).toBe(prFactKey(row));
  });

  it('falls back to baseRefName only when baseSha is nullish', () => {
    const row = fact({ baseSha: undefined });
    expect(prFactKey({ ...row, baseSha: null })).toBe(prFactKey(row));
    expect(prFactKey({ ...row, baseRefName: 'release' })).not.toBe(prFactKey(row));
    expect(prFactKey(fact({ baseRefName: 'release' }))).toBe(prFactKey(fact()));
  });

  it('keys main facts by both repo and immutable main SHA', () => {
    const key = mainFactKey({ repo: REPO, mainSha: 'aaa' });
    expect(typeof key).toBe('string');
    expect(mainFactKey({ repo: REPO, mainSha: 'aaa' })).toBe(key);
    expect(mainFactKey({ repo: REPO, mainSha: 'bbb' })).not.toBe(key);
    expect(mainFactKey({ repo: 'org/other', mainSha: 'aaa' })).not.toBe(key);
    expect(key).not.toBe(prFactKey(fact()));
  });
});

describe('fact storage, scoped eviction and TTL', () => {
  it('drops only the superseded key for the same repo and PR', () => {
    const { cache } = harness();
    const old = fact();
    const next = fact({ headRefOid: 'new-head' });
    const sibling = fact({ number: 6 });
    const otherRepo = fact({ repo: 'org/other' });
    for (const row of [old, sibling, otherRepo]) {
      expect(cache.store(prFactKey(row), row, { complete: true })).toBe(true);
    }
    expect(cache.store(prFactKey(next), next, { complete: true })).toBe(true);
    expect(cache.lookup(prFactKey(old))).toBeNull();
    expect(cache.lookup(prFactKey(next))).toEqual(next);
    expect(cache.lookup(prFactKey(sibling))).toEqual(sibling);
    expect(cache.lookup(prFactKey(otherRepo))).toEqual(otherRepo);
    expect(cache.stats().evictions).toBe(1);
  });

  it('expires after the injected TTL using the injected clock', () => {
    const { cache, setNow } = harness({ ttlMs: 100 });
    const key = prFactKey(fact());
    expect(cache.lookup(key)).toBeNull();
    cache.store(key, fact(), { complete: true });
    setNow(START + 99);
    expect(cache.lookup(key)).toEqual(fact());
    setNow(START + 101);
    expect(cache.lookup(key)).toBeNull();
  });

  it('defaults to a ten-minute TTL', () => {
    const { cache, setNow } = harness();
    const key = prFactKey(fact());
    cache.store(key, fact(), { complete: true });
    setNow(START + 600_000 - 1);
    expect(cache.lookup(key)).toEqual(fact());
    setNow(START + 600_000 + 1);
    expect(cache.lookup(key)).toBeNull();
  });

  it.each([false, undefined, null, 'true', 1])('refuses completeness value %s', complete => {
    const { cache } = harness();
    const key = prFactKey(fact());
    expect(cache.store(key, fact(), { complete })).toBe(false);
    expect(cache.lookup(key)).toBeNull();
  });

  it.each([[null], [[]], ['row'], [42], [new Date(START)], [new Map()]])('refuses a non-plain fact row: %s', row => {
    const { cache } = harness();
    const key = prFactKey(fact());
    expect(cache.store(key, row, { complete: true })).toBe(false);
    expect(cache.lookup(key)).toBeNull();
  });

  it('refuses discoveryIncomplete evidence even if complete is incorrectly true', () => {
    const { cache } = harness();
    const row = fact({ discoveryIncomplete: true });
    expect(cache.store(prFactKey(row), row, { complete: true })).toBe(false);
    expect(cache.lookup(prFactKey(row))).toBeNull();
  });

  it('a refused replacement neither stores nor evicts the last complete facts', () => {
    const { cache } = harness();
    const old = fact();
    const next = fact({ headRefOid: 'new-head' });
    cache.store(prFactKey(old), old, { complete: true });
    expect(cache.store(prFactKey(next), next, { complete: false })).toBe(false);
    expect(cache.lookup(prFactKey(old))).toEqual(old);
    expect(cache.lookup(prFactKey(next))).toBeNull();
  });

  it('counts hits, misses, stores, refusals and evictions and resets only pass statistics', () => {
    const { cache } = harness();
    const row = fact();
    const key = prFactKey(row);
    cache.lookup(key);
    cache.store(key, row, { complete: false });
    cache.store(key, row, { complete: true });
    cache.lookup(key);
    const next = fact({ headRefOid: 'new-head' });
    cache.store(prFactKey(next), next, { complete: true });
    expect(cache.stats()).toEqual({ hits: 1, misses: 1, stores: 2, refused: 1, evictions: 1 });
    cache.resetStats();
    expect(cache.stats()).toEqual({ hits: 0, misses: 0, stores: 0, refused: 0, evictions: 0 });
    expect(cache.lookup(prFactKey(next))).toEqual(next);
  });
});

describe('restart-safe snapshots', () => {
  it('round-trips JSON and preserves original storedAt instead of renewing TTL at restart', async () => {
    const fs = memoryFs();
    const options = { ...fs, snapshotPath: 'planner-facts.json', ttlMs: 100 };
    const first = harness(options);
    const key = prFactKey(fact());
    first.cache.store(key, fact(), { complete: true });
    await first.cache.saveSnapshot();
    expect(fs.writeFile).toHaveBeenCalled();
    expect(() => JSON.parse(fs.files.get(options.snapshotPath))).not.toThrow();
    const second = harness(options);
    second.setNow(START + 80);
    await second.cache.loadSnapshot();
    expect(second.cache.lookup(key)).toEqual(fact());
    second.setNow(START + 101);
    expect(second.cache.lookup(key)).toBeNull();
    const third = harness(options);
    third.setNow(START + 101);
    await third.cache.loadSnapshot();
    expect(third.cache.lookup(key)).toBeNull();
  });

  it.each(['missing', 'unreadable', 'corrupt'])('%s snapshot loads empty without throwing', async kind => {
    const fs = memoryFs();
    if (kind === 'corrupt') fs.files.set('planner-facts.json', '{broken');
    if (kind === 'unreadable') fs.readFile.mockImplementation(() => { throw new Error('EACCES'); });
    const { cache } = harness({ ...fs, snapshotPath: 'planner-facts.json' });
    await expect((async () => { await cache.loadSnapshot(); })()).resolves.toBeUndefined();
    expect(cache.lookup(prFactKey(fact()))).toBeNull();
  });
});

describe('fresh-driven shadow reads', () => {
  it('always reads fresh on a hit and returns fresh facts while reporting deep paths', async () => {
    const { cache } = harness();
    const key = prFactKey(fact());
    const cached = fact({ evidence: { commits: [{ oid: 'old' }] } });
    const fresh = fact({ evidence: { commits: [{ oid: 'new' }] } });
    cache.store(key, cached, { complete: true });
    const readFresh = vi.fn(() => fresh);
    const result = await readThroughShadow({ cache, key, readFresh, complete: true });
    expect(readFresh).toHaveBeenCalledTimes(1);
    expect(result.row).toBe(fresh);
    expect(result.shadow).toMatchObject({ hit: true, same: false });
    expect(result.shadow.diffs).toHaveLength(1);
    // Accept dot or bracket array notation, but require the full changed leaf path.
    expect(result.shadow.diffs[0]).toEqual({
      path: expect.stringMatching(/^\/?evidence(?:\.|\/)commits(?:\.0|\[0\]|\/0)(?:\.|\/)oid$/),
      cached: 'old', fresh: 'new',
    });
    expect(cache.lookup(key)).toEqual(fresh);
  });

  it('deep-compares equal rows regardless of object insertion order', async () => {
    const { cache } = harness();
    expect(cache.compareShadow({ a: [1, { b: true }], c: null }, { c: null, a: [1, { b: true }] }))
      .toEqual({ same: true, diffs: [] });
    const key = prFactKey(fact());
    cache.store(key, fact(), { complete: true });
    const readFresh = vi.fn(() => fact());
    const result = await readThroughShadow({ cache, key, readFresh, complete: true });
    expect(readFresh).toHaveBeenCalledTimes(1);
    expect(result.shadow).toEqual({ hit: true, same: true, diffs: [] });
  });

  it('reports additions, removals and array changes instead of ignoring structural differences', () => {
    const { cache } = harness();
    const result = cache.compareShadow({ gone: 1, list: [1] }, { added: 2, list: [2] });
    expect(result.same).toBe(false);
    expect(result.diffs).toHaveLength(3);
    expect(result.diffs).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: expect.stringMatching(/gone$/), cached: 1, fresh: undefined }),
      expect.objectContaining({ path: expect.stringMatching(/added$/), cached: undefined, fresh: 2 }),
      expect.objectContaining({ cached: 1, fresh: 2 }),
    ]));
  });

  it('reads fresh on a miss but never stores an incomplete read', async () => {
    const { cache } = harness();
    const key = prFactKey(fact());
    const fresh = fact({ discoveryIncomplete: true });
    const readFresh = vi.fn(() => fresh);
    const result = await readThroughShadow({ cache, key, readFresh, complete: false });
    expect(readFresh).toHaveBeenCalledTimes(1);
    expect(result.row).toBe(fresh);
    expect(result.shadow.hit).toBe(false);
    expect(cache.lookup(key)).toBeNull();
    expect(cache.stats().stores).toBe(0);
  });

  it('an incomplete fresh read on a hit cannot replace previously complete facts', async () => {
    const { cache } = harness();
    const key = prFactKey(fact());
    cache.store(key, fact(), { complete: true });
    const fresh = fact({ discoveryIncomplete: true });
    const readFresh = vi.fn(() => fresh);
    const result = await readThroughShadow({ cache, key, readFresh, complete: false });
    expect(readFresh).toHaveBeenCalledTimes(1);
    expect(result.row).toBe(fresh);
    expect(result.shadow.hit).toBe(true);
    expect(cache.lookup(key)).toEqual(fact());
    expect(cache.stats().stores).toBe(1);
  });

  it('a failed fresh read never falls back to cached facts or stores a replacement', async () => {
    const { cache } = harness();
    const key = prFactKey(fact());
    cache.store(key, fact(), { complete: true });
    const readFresh = vi.fn(() => { throw new Error('read failed'); });
    await expect((async () => readThroughShadow({ cache, key, readFresh, complete: true }))())
      .rejects.toThrow('read failed');
    expect(readFresh).toHaveBeenCalledTimes(1);
    expect(cache.lookup(key)).toEqual(fact());
    expect(cache.stats().stores).toBe(1);
  });
});

describe('persisted shadow promotion evidence', () => {
  it.each([
    [47, 100, 0, false], [48, 99, 0, false],
    [48, 100, 1, false], [48, 100, 0, true],
  ])('at %sh / %s passes / %s diffs, met=%s', (hours, passes, diffs, met) => {
    const { cache, setNow } = harness();
    for (let i = 0; i < passes; i++) cache.recordPass({ diffCount: i === 0 ? diffs : 0, compared: 1 });
    setNow(START + hours * HOUR);
    const result = cache.shadowEndRule({ now: START + hours * HOUR });
    expect(result).toMatchObject({ met, hours, passes, diffs, reason: expect.any(String) });
    expect(result.reason.length).toBeGreaterThan(0);
  });

  it('never promotes on passes that compared no rows (empty shadow evidence)', () => {
    const { cache, setNow } = harness();
    for (let i = 0; i < 100; i++) cache.recordPass({ diffCount: 0, compared: 0 });
    setNow(START + 48 * HOUR);
    expect(cache.shadowEndRule({ now: START + 48 * HOUR })).toMatchObject({ met: false, passes: 100, comparedPasses: 0 });
  });

  it('persists firstShadowAt and cumulative passes/diffs across restart and stats reset', async () => {
    const fs = memoryFs();
    const options = { ...fs, snapshotPath: 'planner-facts.json' };
    const first = harness(options);
    first.cache.recordPass({ diffCount: 2 });
    first.setNow(START + HOUR);
    first.cache.recordPass({ diffCount: 1 });
    first.cache.resetStats();
    await first.cache.saveSnapshot();
    const second = harness(options);
    second.setNow(START + 48 * HOUR);
    await second.cache.loadSnapshot();
    second.cache.recordPass({ diffCount: 0, compared: 1 });
    expect(second.cache.shadowEndRule({ now: START + 48 * HOUR }))
      .toMatchObject({ met: false, hours: 48, passes: 3, diffs: 3 });
  });
});

describe('facts stay below live time-based decisions', () => {
  it('identical cached PR facts yield a different real plan after the hung window elapses', () => {
    const { cache, setNow } = harness({ ttlMs: 2 * HOUR });
    const row = fact({ number: 2582, labels: [{ name: 'review:pending' }],
      statusCheckRollup: [{ name: 'gate', status: 'completed', conclusion: 'success' }] });
    const key = prFactKey(row);
    cache.store(key, row, { complete: true });
    const original = structuredClone(row);
    const agent = { name: 'review-2582', state: 'working', status: 'idle',
      startedAt: START, pid: 4242, pidAlive: true, sessionId: 's-2582' };
    const thresholdMs = 30 * 60_000;
    const hungInfoFor = (_agent, nowMs, threshold) => classifyHungSession({
      lastActivityMs: START, nowMs, thresholdMs: threshold,
    });
    const pass = now => {
      setNow(now);
      const cachedFacts = cache.lookup(key);
      expect(cachedFacts).toEqual(original);
      const agents = markHungSessions([agent], hungInfoFor, now, thresholdMs);
      return { agents, plan: planReconcile({ prs: [cachedFacts], agents, now,
        durableCounts: {}, requiredChecks: ['gate'], reviewTiming: { startAfter: 'ci-green' } }) };
    };
    const before = pass(START + thresholdMs - 1);
    const after = pass(START + thresholdMs + 1);
    expect(before.agents[0].hung).not.toBe(true);
    expect(after.agents[0].hung).toBe(true);
    expect(before.plan.dispatch).toHaveLength(0);
    expect(before.plan.refusals).toContainEqual(expect.objectContaining({ kind: 'live-process', prNumber: 2582 }));
    expect(after.plan.dispatch).toContainEqual(expect.objectContaining({ kind: 'review', prNumber: 2582 }));
    expect(after.plan).not.toEqual(before.plan);
    expect(cache.lookup(key)).toEqual(original);
    expect(cache.stats().stores).toBe(1);
    expect(cache.stats().hits).toBe(3);
  });

  it.each(['plan', 'dispatch'])('rejects a row carrying a %s decision payload', field => {
    const { cache } = harness();
    const key = prFactKey(fact());
    expect(cache.store(key, fact({ [field]: [] }), { complete: true })).toBe(false);
    expect(cache.lookup(key)).toBeNull();
  });

  it('has no planner import/reference or named decision-storage API in the cache source', () => {
    const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../planner-fact-cache.mjs'), 'utf8');
    expect(source).not.toMatch(/\bplanReconcile\b/);
    expect(source).not.toMatch(/\b(?:store|cache|save|lookup|get)(?:Plan|Dispatch|Decision|ReconcileResult|HungSessions|LedgerHolds)\b/);
  });
});

describe('defaultReadPrs shadow wiring contract (round 2)', () => {
  function readerFixture() {
    const { cache } = harness({ mode: 'shadow' });
    // A full listing page deliberately reaches the expensive complete-comments seam.
    const comments = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, body: `comment ${i}` }));
    let listing = fact({ labels: [], comments });
    const exec = vi.fn((file, args) => {
      expect(file).toBe('gh');
      expect(args.slice(0, 2)).toEqual(['pr', 'list']);
      return JSON.stringify([listing]);
    });
    const readCommits = vi.fn(() => [{ oid: 'commit-1', messageHeadline: 'repair' }]);
    const readComments = vi.fn(() => [...comments, { id: 101, body: 'complete thread' }]);
    const lookup = vi.spyOn(cache, 'lookup');
    const compare = vi.spyOn(cache, 'compareShadow');
    const read = () => defaultReadPrs({ repo: REPO, exec, readCommits, readComments, factCache: cache });
    return { cache, read, readCommits, readComments, exec, lookup, compare,
      changeHead: () => { listing = { ...listing, headRefOid: 'new-head' }; } };
  }

  it('second identical listing still reads commits/comments fresh but records a hit and zero diffs', () => {
    const f = readerFixture();
    const first = f.read();
    expect(first).toHaveLength(1);
    expect(first[0].commentsComplete).toBe(true);
    f.cache.resetStats();
    f.lookup.mockClear();
    f.compare.mockClear();
    const second = f.read();
    expect(second).toEqual(first);
    expect(f.exec).toHaveBeenCalledTimes(2);
    expect(f.readCommits).toHaveBeenCalledTimes(2);
    expect(f.readComments).toHaveBeenCalledTimes(2);
    expect(f.lookup.mock.results.some(result => result.type === 'return' && result.value !== null)).toBe(true);
    expect(f.compare).toHaveBeenCalled();
    expect(f.compare.mock.results.every(result => result.type === 'return'
      && result.value.same === true && result.value.diffs.length === 0)).toBe(true);
    expect(f.cache.stats()).toMatchObject({ hits: 1, misses: 0 });
  });

  it('a changed head records a miss while still reading commits/comments fresh', () => {
    const f = readerFixture();
    f.read();
    f.changeHead();
    f.cache.resetStats();
    f.lookup.mockClear();
    const second = f.read();
    expect(second[0].headRefOid).toBe('new-head');
    expect(f.readCommits).toHaveBeenCalledTimes(2);
    expect(f.readComments).toHaveBeenCalledTimes(2);
    expect(f.lookup).toHaveBeenCalled();
    expect(f.lookup.mock.results.every(result => result.type === 'return' && result.value === null)).toBe(true);
    expect(f.cache.stats()).toMatchObject({ hits: 0, misses: 1 });
  });
});


describe('shadow safety regression coverage', () => {
  it('logs changed heavy facts and returns the fresh comments on a cache hit', () => {
    const { cache } = harness();
    const comments = Array.from({ length: 100 }, (_, id) => ({ id, body: `comment ${id}` }));
    const listing = fact({ labels: [], comments });
    const readComments = vi.fn().mockReturnValueOnce([...comments, { id: 101, body: 'old' }])
      .mockReturnValueOnce([...comments, { id: 101, body: 'fresh' }]);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const read = () => defaultReadPrs({ repo: REPO, exec: () => JSON.stringify([listing]),
        readCommits: () => [], readComments, factCache: cache });
      read();
      expect(read()[0].comments.at(-1).body).toBe('fresh');
      expect(cache.diffCount).toBe(1);
      expect(log).toHaveBeenCalledWith(expect.stringMatching(/^planner-cache-diff .*comments\.100\.body/));
    } finally { log.mockRestore(); }
  });

  it('does not store a row dropped by the complete-comment reader or an incomplete listing', () => {
    const { cache } = harness();
    const comments = Array.from({ length: 100 }, (_, id) => ({ id, body: `comment ${id}` }));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const dropped = defaultReadPrs({ repo: REPO, exec: () => JSON.stringify([fact({ labels: [], comments })]),
        readCommits: () => [], readComments: () => { throw Error('unreadable'); }, factCache: cache });
      expect(dropped).toHaveLength(0);
      expect(dropped.discoveryIncomplete).toBe(true);
      defaultReadPrs({ repo: REPO, exec: () => JSON.stringify([fact({ discoveryIncomplete: true })]),
        readCommits: () => [], factCache: cache });
      expect(cache.stats().stores).toBe(0);
    } finally { log.mockRestore(); }
  });

  it('returns failed commit evidence fresh but refuses to cache it', () => {
    const { cache } = harness();
    const rows = defaultReadPrs({ repo: REPO, exec: () => JSON.stringify([fact({ labels: [] })]),
      readCommits: () => null, factCache: cache });
    expect(rows[0].commits).toBeNull();
    expect(cache.stats().stores).toBe(0);
    expect(cache.stats().refused).toBe(1);
  });

  it('off mode bypasses the shadow observer', () => {
    const { cache } = harness({ mode: 'off' });
    const lookup = vi.spyOn(cache, 'lookup');
    const opts = { repo: REPO, exec: () => JSON.stringify([fact()]), readCommits: () => [] };
    expect(defaultReadPrs({ ...opts, factCache: cache })).toEqual(defaultReadPrs(opts));
    expect(lookup).not.toHaveBeenCalled();
  });

  it('daemon passes share one injected cache, persist evidence and append metrics', async () => {
    const { buildCliDaemonEffects } = await import('../../../skills-src/conveyor/review-daemon.mjs');
    const fs = memoryFs();
    const { cache } = harness({ ...fs, snapshotPath: 'daemon-facts.json' });
    const lines = [];
    const suppliedCaches = [];
    const effects = buildCliDaemonEffects({ owner: 'test', factCache: cache,
      log: { error: line => lines.push(line) }, reapSessions: () => null,
      reviewTickOpts: ({ factCache }) => { suppliedCaches.push(factCache); return {}; },
      tick: () => ({ reviewsOwed: 0, refusals: 0, dispatched: [], failed: [] }),
      convertAdvisoryEnabled: false, runPrepReview: () => null,
    });
    await effects.tickOnce();
    await effects.tickOnce();
    expect(suppliedCaches).toEqual([cache, cache]);
    expect(cache.shadowEndRule()).toMatchObject({ passes: 2, diffs: 0 });
    expect(JSON.parse(fs.files.get('daemon-facts.json')).evidence.passes).toBe(2);
    expect(lines.filter(line => line.includes('pass timings'))).toHaveLength(2);
    expect(lines.filter(line => line.includes('pass timings')).every(line =>
      line.includes('planner-cache hits=0 misses=0 diffs=0 shadowEndRule='))).toBe(true);
  });
});
