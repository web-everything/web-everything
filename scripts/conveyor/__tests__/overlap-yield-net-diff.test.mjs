import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildOverlapRows, refineOverlapRowsToNetDiff } from '../../merge-ai-prs.mjs';
import { overlapYieldWaits } from '../land-overlap-yield.mjs';

const repo = 'web-everything/web-everything';
const sha = (c) => c.repeat(40);
const raw = (number, listed, labels = ['review:accepted', 'ready-to-merge']) => ({ number, baseRefName: 'main', headRefOid: sha(String(number % 10)), labels,
  statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }], files: listed.map((path) => ({ path, additions: 1, deletions: 0 })) });
const rowsFor = (xLabels, yLabels, xFiles = ['a.mjs'], yFiles = ['a.mjs']) => {
  const x = raw(6679, xFiles, xLabels), y = raw(6381, yFiles, yLabels);
  // a single-PR fast drain: only the target X has a verdict, the held Y does not
  const verdicts = [{ num: 6679, repo, decision: 'merge' }];
  return buildOverlapRows({ candidates: verdicts, verdicts, openPrContext: { prsByRepo: new Map([[null, [x, y]]]) }, localSlug: repo });
};
const waits = (rows) => overlapYieldWaits({ candidates: rows.candidateRows, openPrs: rows.openPrRows, nowMs: 0, ignoreBudget: true });
const ok = ['review:accepted', 'ready-to-merge'];
afterEach(() => vi.unstubAllEnvs());

describe('overlap-yield never yields to a PR that is itself held', () => {
  it.each(['red-team:pending', 'red-team:blocked', 'review:human'])('no yield to a verdict-less target labelled %s', (label) => {
    expect(waits(rowsFor(ok, [...ok, label])).size).toBe(0);
  });
  it('still yields to a landable verdict-less target', () => {
    expect(waits(rowsFor(ok, ok)).get(`${repo}#6679`).yieldTo).toBe(6381);
  });
});

describe('refineOverlapRowsToNetDiff', () => {
  const run = (readFiles, rows = rowsFor(ok, ok)) => refineOverlapRowsToNetDiff({ ...rows, localSlug: repo, readFiles, cache: new Map() });
  it('drops a stale listing overlap when the net diffs are disjoint', () => {
    const readFiles = ({ headSha }) => ({ files: headSha === sha('9') ? ['x.test.mjs'] : ['y.rs'] });
    expect(waits(run(readFiles)).size).toBe(0);
  });
  it('keeps a real net-diff overlap yielding', () => {
    expect(waits(run(() => ({ files: ['shared.mjs'] }))).get(`${repo}#6679`).yieldTo).toBe(6381);
  });
  it('keeps the listing when a net diff is unreadable', () => {
    expect(waits(run(() => ({ error: 'boom' }))).get(`${repo}#6679`).yieldTo).toBe(6381);
  });
  it('reads each head+base once', () => {
    const readFiles = vi.fn(() => ({ files: ['shared.mjs'] }));
    const cache = new Map();
    const rows = rowsFor(ok, ok);
    refineOverlapRowsToNetDiff({ ...rows, localSlug: repo, readFiles, cache });
    refineOverlapRowsToNetDiff({ ...rows, localSlug: repo, readFiles, cache });
    expect(readFiles).toHaveBeenCalledTimes(2);
  });
  it('does not read when nothing overlaps in the listing', () => {
    const readFiles = vi.fn(() => ({ files: [] }));
    run(readFiles, rowsFor(ok, ok, ['a.mjs'], ['b.mjs']));
    expect(readFiles).not.toHaveBeenCalled();
  });
});

describe('refineOverlapRowsToNetDiff audit findings', () => {
  it('keeps listing sizes so land order still ranks by size', () => {
    const rows = rowsFor(ok, ok);
    rows.openPrRows.find((r) => r.number === 6381).files[0].additions = 500;
    const out = refineOverlapRowsToNetDiff({ ...rows, localSlug: repo, readFiles: () => ({ files: ['a.mjs'] }), cache: new Map() });
    expect(out.openPrRows.find((r) => r.number === 6381).files[0].additions).toBe(500);
  });
  it('one unreadable net diff keeps every listing, never a mixed set', () => {
    const rows = rowsFor(ok, ok);
    const readFiles = ({ headSha }) => (headSha === sha('9') ? { files: ['other.mjs'] } : { error: 'boom' });
    expect(waits(refineOverlapRowsToNetDiff({ ...rows, localSlug: repo, readFiles, cache: new Map() })).get(`${repo}#6679`).yieldTo).toBe(6381);
  });
});

describe('refineOverlapRowsToNetDiff audit round 2', () => {
  it('a cached read expires so a moved base is re-read', () => {
    vi.useFakeTimers();
    const readFiles = vi.fn(() => ({ files: ['shared.mjs'] }));
    const cache = new Map();
    const rows = rowsFor(ok, ok);
    refineOverlapRowsToNetDiff({ ...rows, localSlug: repo, readFiles, cache });
    vi.advanceTimersByTime(61_000);
    refineOverlapRowsToNetDiff({ ...rows, localSlug: repo, readFiles, cache });
    vi.useRealTimers();
    expect(readFiles).toHaveBeenCalledTimes(4);
  });
  it('a row with no head sha keeps every listing', () => {
    const rows = rowsFor(ok, ok);
    rows.openPrRows.find((r) => r.number === 6381).headSha = null;
    expect(waits(refineOverlapRowsToNetDiff({ ...rows, localSlug: repo, readFiles: () => ({ files: ['other.mjs'] }), cache: new Map() })).get(`${repo}#6679`).yieldTo).toBe(6381);
  });
});

describe('refined rows keep the listing size for land ranking', () => {
  it('a dropped big file still counts toward the row size', () => {
    const rows = rowsFor(ok, ok, ['a.mjs'], ['a.mjs']);
    rows.openPrRows.find((r) => r.number === 6381).files.push({ path: 'big.txt', additions: 1000, deletions: 0 });
    const out = refineOverlapRowsToNetDiff({ ...rows, localSlug: repo, readFiles: () => ({ files: ['a.mjs'] }), cache: new Map() });
    expect(out.openPrRows.find((r) => r.number === 6381).sizeLines).toBe(1001);
  });
});
