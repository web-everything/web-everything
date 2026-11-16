// @vitest-environment node
import {describe, it, expect} from 'vitest';
import {parseTelemetry, sampleRootDisk, stableActiveRunIds} from '../forge-exec-run.mjs';

const A = 'r-' + 'a'.repeat(32), B = 'r-' + 'b'.repeat(32);
const base = {sampledAtET: '2026-11-03T15:00:00.000-05:00', cores: 4, loadPerCore: 0.5, memFreePct: 50, recent: []};
describe('R518 telemetry activeRunIds', () => {
  it('accepts a sample without the field (older Forge)', () => {
    expect(parseTelemetry(JSON.stringify({...base, activeRuns: 1}))).toEqual({...base, activeRuns: 1});
  });
  it('accepts activeRunIds matching the count', () => {
    expect(parseTelemetry(JSON.stringify({...base, activeRuns: 2, activeRunIds: [A, B]})).activeRunIds).toEqual([A, B]);
  });
  it.each([
    ['count mismatch', {activeRuns: 1, activeRunIds: [A, B]}],
    ['bad id', {activeRuns: 1, activeRunIds: ['x']}],
    ['duplicate', {activeRuns: 2, activeRunIds: [A, A]}],
    ['not an array', {activeRuns: 0, activeRunIds: null}],
    ['unknown extra key', {activeRuns: 0, activeRunIds: [], extra: 1}],
  ])('rejects %s', (_l, extra) => {
    expect(() => parseTelemetry(JSON.stringify({...base, ...extra}))).toThrow('Invalid telemetry schema');
  });
});

describe('Forge disk/prune telemetry schema', () => {
  it('accepts the live disk-full and repeated-prune-refusal sample', () => {
    const value = {...base, activeRuns: 0, diskUsedPct: 100,
      prune: {consecutiveRefused: 469, lastRefusal: 'Invalid reserved lock evidence'}};
    expect(parseTelemetry(JSON.stringify(value))).toEqual(value);
  });
  it.each([
    {diskUsedPct: null, prune: null},
    {diskUsedPct: 80},
    {prune: {consecutiveRefused: 3, lastRefusal: 'refused'}},
  ])('accepts partial or unavailable readings without hiding other telemetry: %j', fields => {
    const value = {...base, activeRuns: 0, ...fields};
    expect(parseTelemetry(JSON.stringify(value))).toEqual(value);
  });
  it.each([
    {diskUsedPct: -1}, {diskUsedPct: 101}, {diskUsedPct: '100'},
    {prune: {}}, {prune: {consecutiveRefused: -1, lastRefusal: ''}},
    {prune: {consecutiveRefused: 1.5, lastRefusal: ''}},
    {prune: {consecutiveRefused: 3, lastRefusal: 1}},
    {prune: {consecutiveRefused: 3, lastRefusal: 'x'.repeat(201)}},
    {prune: {consecutiveRefused: 3, lastRefusal: '', extra: true}},
  ])('rejects malformed readings: %j', fields => {
    expect(() => parseTelemetry(JSON.stringify({...base, activeRuns: 0, ...fields}))).toThrow('Invalid telemetry schema');
  });
});

describe('Forge root filesystem sampling', () => {
  it.each([
    [100, 100, 100, 0], [100, 21, 21, 79], [100, 20, 20, 80],
    [100, 0, 0, 100], [100, 20, 10, 89], [100, 3, -2, 100],
  ])('matches df capacity for blocks=%i free=%i available=%i', async (blocks, bfree, bavail, expected) => {
    expect(await sampleRootDisk(async path => {
      expect(path).toBe('/'); return {blocks, bfree, bavail};
    })).toBe(expected);
  });
  it.each([
    {blocks: 0, bfree: 0, bavail: 0}, {blocks: 100, bfree: -1, bavail: 0},
    {blocks: 100, bfree: 101, bavail: 1}, {blocks: 100, bfree: 20, bavail: 21},
    {blocks: NaN, bfree: 1, bavail: 1}, {blocks: 100, bfree: 10, bavail: '10'},
  ])('refuses invalid filesystem evidence: %j', async reading => {
    await expect(sampleRootDisk(async () => reading)).rejects.toThrow();
  });
});

describe('R518 stable active-run listing (audit: one listing can miss a prepared->running rename)', () => {
  const listing = (...rounds) => { let i = 0; return async () => rounds[Math.min(i++, rounds.length - 1)]; };
  it('returns the ids when two consecutive listings agree', async () => {
    expect(await stableActiveRunIds(listing([A + '.running'], [A + '.running']))).toEqual({stable: true, ids: [A], count: 1});
  });
  it('a listing that missed the renamed run is not trusted: it retries until two agree', async () => {
    expect(await stableActiveRunIds(listing([], [A + '.running'], [A + '.running']))).toEqual({stable: true, ids: [A], count: 1});
  });
  it('never stabilising omits the list and never reports a false zero (union count, at least 1)', async () => {
    let n = 0;
    expect(await stableActiveRunIds(async () => (n++ % 2 ? [A + '.running'] : []), 4)).toEqual({stable: false, ids: undefined, count: 1});
  });
  it('a run seen in every listing still counts when another run keeps the listing unstable', async () => {
    let n = 0;
    const r = await stableActiveRunIds(async () => [A + '.running', ...(n++ % 2 ? [B + '.running'] : [])], 4);
    expect(r.stable).toBe(false);
    expect(r.count).toBe(2);
  });
});
