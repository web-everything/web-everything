// @vitest-environment node
import {describe, it, expect} from 'vitest';
import {parseTelemetry, stableActiveRunIds} from '../forge-exec-run.mjs';

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

describe('R518 stable active-run listing (audit: one listing can miss a prepared->running rename)', () => {
  const listing = (...rounds) => { let i = 0; return async () => rounds[Math.min(i++, rounds.length - 1)]; };
  it('returns the ids when two consecutive listings agree', async () => {
    expect(await stableActiveRunIds(listing([A + '.running'], [A + '.running']))).toEqual([A]);
  });
  it('a listing that missed the renamed run is not trusted: it retries until two agree', async () => {
    expect(await stableActiveRunIds(listing([], [A + '.running'], [A + '.running']))).toEqual([A]);
  });
  it('never stabilising omits the list (readers fall back to the zero-active rule)', async () => {
    let n = 0;
    expect(await stableActiveRunIds(async () => (n++ % 2 ? [A + '.running'] : []), 4)).toBeUndefined();
  });
});
