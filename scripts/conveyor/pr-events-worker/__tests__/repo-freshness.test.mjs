/** Per-repo freshness on GET /prs (R417): bootstrapAt, lastEventAt, coverage, each from that repo's own rows only. */
import { describe, it, expect } from 'vitest';
import { createEventLog, createMemoryStorage, parseGithubEvent } from '../core.mjs';

const T = 1_000_000_000_000;
const ev = (repo, n = 1, id = `${repo}-${n}-${Math.random()}`) => parseGithubEvent('pull_request', {
  repository: { full_name: repo }, number: n, action: 'opened', pull_request: { head: { sha: 'a' }, draft: false, labels: [], state: 'open' },
}, { deliveryId: id, receivedAt: T });
const seed = (repo, baseCursor = 0, status = 'complete', importId = 'i1') => ({ repo, importId, baseCursor, status, prs: [] });

describe('GET /prs per-repo freshness', () => {
  it('never shows one repo\'s fresh event on another repo with an old bootstrap', () => {
    const log = createEventLog(createMemoryStorage());
    log.bootstrap(seed('o/b'), T - 86_400_000);
    log.bootstrap(seed('o/a'), T - 86_400_000);
    log.append(ev('o/a'), T);
    const { repos } = log.readPrs(null, 10, T + 1000);
    expect(repos['o/a']).toEqual({ bootstrapAt: T - 86_400_000, lastEventAt: T, coverage: true });
    expect(repos['o/b']).toEqual({ bootstrapAt: T - 86_400_000, lastEventAt: null, coverage: true });
  });

  it('reports coverage false once the cursor is no longer contiguous after bootstrap', () => {
    const log = createEventLog(createMemoryStorage(), { maxEvents: 2 });
    log.append(ev('o/a', 1), T);
    log.bootstrap(seed('o/a', 1), T);
    for (let n = 2; n < 6; n += 1) log.append(ev('o/a', n), T);
    expect(log.readPrs(null, 10, T).repos['o/a'].coverage).toBe(false);
  });

  it('reports null bootstrapAt and coverage false with no bootstrap', () => {
    const log = createEventLog(createMemoryStorage());
    log.append(ev('o/a'), T);
    expect(log.readPrs(null, 10, T).repos['o/a']).toEqual({ bootstrapAt: null, lastEventAt: T, coverage: false });
  });

  it('is false for truncated or failed bootstraps', () => {
    const log = createEventLog(createMemoryStorage());
    log.bootstrap(seed('o/a', 0, 'truncated'), T);
    log.bootstrap(seed('o/b', 0, 'failed'), T);
    const { repos } = log.readPrs(null, 10, T);
    expect([repos['o/a'].coverage, repos['o/b'].coverage]).toEqual([false, false]);
  });

  it('rejects times later than now + 60 s (null, coverage false), not shown as fresh', () => {
    const log = createEventLog(createMemoryStorage());
    log.bootstrap(seed('o/a'), T + 3_600_000);
    log.append(ev('o/a'), T + 3_600_000);
    const row = log.readPrs(null, 10, T).repos['o/a'];
    expect(row).toEqual({ bootstrapAt: null, lastEventAt: null, coverage: false });
    expect(log.readPrs(null, 10, T + 3_600_000).repos['o/a'].coverage).toBe(true);
  });

  it('a future event time with a valid bootstrap voids coverage', () => {
    const log = createEventLog(createMemoryStorage());
    log.bootstrap(seed('o/a'), T);
    log.append(ev('o/a'), T + 3_600_000);
    expect(log.readPrs(null, 10, T).repos['o/a']).toEqual({ bootstrapAt: T, lastEventAt: null, coverage: false });
  });

  it('a delayed complete import at the same cursor cannot close PRs a newer import seeded', () => {
    const log = createEventLog(createMemoryStorage());
    log.bootstrap({ ...seed('o/a', 0, 'complete', 'new'), prs: [{ number: 1, sha: 'a', draft: false, labels: [], state: 'open' }] }, T);
    log.bootstrap(seed('o/a', 0, 'complete', 'old'), T);
    expect(log.readPrs(null, 10, T).prs[0].state).toBe('open');
  });

  it('a same-cursor complete import after a truncation gives coverage false until a later cursor', () => {
    const log = createEventLog(createMemoryStorage());
    log.bootstrap({ ...seed('o/a', 0, 'truncated', 't'), prs: [{ number: 1, sha: 'a', draft: false, labels: [], state: 'open' }] }, T);
    log.bootstrap(seed('o/a', 0, 'complete', 'c'), T);
    expect(log.readPrs(null, 10, T).repos['o/a'].coverage).toBe(false);
    log.append(ev('o/b', 9), T);
    log.bootstrap(seed('o/a', 1, 'complete', 'c2'), T);
    expect(log.readPrs(null, 10, T).repos['o/a'].coverage).toBe(true);
  });

  it('keeps every existing /prs field (additive only)', () => {
    const log = createEventLog(createMemoryStorage());
    log.append(ev('o/a'), T);
    const body = log.readPrs(null, 10, T);
    expect(Object.keys(body).sort()).toEqual(['cursor', 'coverage', 'events', 'gap', 'head', 'lastDeliveryAt', 'lastEventAt', 'more', 'prs', 'repos', 'reset', 'stateCursor'].sort());
    expect(body.coverage).toMatchObject({ partial: true, bootstrap: [] });
    expect(body.lastEventAt).toBe(T);
  });
});
