// @vitest-environment node
/** The measure diff base is the last successfully measured main commit, never HEAD~1. */
import { describe, expect, it } from 'vitest';
import { pickMeasureBase, coveredMerges, lastMeasuredSha } from '../measure-base.mjs';

const ancestors = (set) => (sha) => set.includes(sha);

describe('pickMeasureBase', () => {
  it('uses the last measured sha when it is an ancestor of head, not HEAD^', () => {
    const r = pickMeasureBase({ head: 'h3', lastMeasured: 'm0', isAncestor: ancestors(['m0']) });
    expect(r.base).toBe('m0');
    expect(r.base).not.toBe('HEAD^');
    expect(r.cumulative).toBe(true);
  });
  it('falls back to HEAD^ with no previous measurement', () => {
    expect(pickMeasureBase({ head: 'h', lastMeasured: null, isAncestor: () => true })).toEqual({ base: 'HEAD^', cumulative: false });
  });
  it('falls back to HEAD^ when the last measured sha is not an ancestor (force-moved main)', () => {
    expect(pickMeasureBase({ head: 'h', lastMeasured: 'gone', isAncestor: () => false }).base).toBe('HEAD^');
  });
  it('falls back to HEAD^ when last measured equals head (re-run)', () => {
    expect(pickMeasureBase({ head: 'h', lastMeasured: 'h', isAncestor: () => true }).base).toBe('HEAD^');
  });
});

describe('lastMeasuredSha', () => {
  const runs = [
    { head_sha: 'c', conclusion: 'cancelled' },
    { head_sha: 'b', conclusion: 'success' },
    { head_sha: 'a', conclusion: 'success' },
  ];
  it('picks the newest successful run other than the current head', () => {
    expect(lastMeasuredSha({ runs, head: 'z' })).toBe('b');
    expect(lastMeasuredSha({ runs, head: 'b' })).toBe('a');
  });
  it('returns null when nothing succeeded', () => {
    expect(lastMeasuredSha({ runs: [{ head_sha: 'c', conclusion: 'cancelled' }], head: 'z' })).toBeNull();
  });
});

describe('coveredMerges', () => {
  it('lists every commit between base and head so per-merge attribution survives a cumulative diff', () => {
    const log = (range) => (range === 'm0..h3' ? 'h3\nh2\nh1\n' : '');
    expect(coveredMerges({ base: 'm0', head: 'h3', runGit: log })).toEqual(['h3', 'h2', 'h1']);
  });
});
