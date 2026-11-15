import { describe, expect, it } from 'vitest';
import { assessCapacity } from '../delivery-capacity.mjs';

const host = { idlePct: 22, memGb: 6 };
const pr = (number, labels = []) => ({
  number, labels, additions: 700, deletions: 0, updatedAt: new Date().toISOString(),
  files: ['scripts/example.mjs'], headRefName: `lane/${number}-build`,
});

describe('delivery capacity documented safety guarantees', () => {
  it.each([null, undefined, [], 'bad row', {}, { number: '2' }, { number: NaN },
    { number: Infinity }, { number: 1.5 }])('malformed PR row forces count fallback and holds starts: %j', row => {
    const readout = assessCapacity({ prs: [pr(1), row], host, policy: { mode: 'units' } });
    expect(readout).toMatchObject({ mode: 'count', used: 2, openCount: 2, cap: 18, verdict: 'hold', slots: 0 });
    expect(readout.fallbackReason).toMatch(/malformed.*finite integer number/);
  });

  it('an incomplete marker forces count fallback and holds starts with available rows', () => {
    const readout = assessCapacity({ prs: [pr(1)], incomplete: true, host, policy: { mode: 'units' } });
    expect(readout).toMatchObject({ mode: 'count', used: 1, openCount: 1, verdict: 'hold', slots: 0 });
    expect(readout.fallbackReason).toMatch(/incomplete.*inspect full population/);
  });

  it.each([200, 201])('a PR list of %i rows forces count fallback and holds starts', length => {
    const readout = assessCapacity({ prs: Array.from({ length }, (_, i) => pr(i + 1)), host,
      policy: { mode: 'units', population: 'builder' } });
    expect(readout).toMatchObject({ mode: 'count', used: length, openCount: length, verdict: 'hold', slots: 0 });
    expect(readout.fallbackReason).toMatch(/200-PR limit.*inspect full population/);
  });

  const nowMs = Date.parse('2026-11-15T12:00:00Z');
  it('a held PR older than the one-hour threshold counts full weight and reports held stale', () => {
    const readout = assessCapacity({ prs: [{ ...pr(1, ['review:human', 'review:accepted']),
      updatedAt: '2026-11-15T10:00:00Z' }], host, nowMs,
      policy: { mode: 'units', heldStaleH: 1 } });
    expect(readout).toMatchObject({ used: 4, held: [], breakdown: { 'held stale': { n: 1, units: 4 } } });
    expect(readout.why.join(' ')).toContain('held stale: 1 charged at full weight');
  });

  it.each([undefined, null, 'unparseable', 123])('a held PR with missing or invalid updatedAt counts full weight: %j', updatedAt => {
    const readout = assessCapacity({ prs: [{ ...pr(1, ['review:human']), updatedAt }], host, nowMs,
      policy: { mode: 'units', heldStaleH: 1 } });
    expect(readout).toMatchObject({ used: 4, breakdown: { 'held stale': { n: 1, units: 4 } } });
    expect(readout.why.join(' ')).toContain('held stale');
  });

  it.each(['2026-11-15T11:30:00Z', '2026-11-15T11:00:00Z'])(
    'a fresh held PR retains its exemption through the one-hour threshold: %s', updatedAt => {
      const readout = assessCapacity({ prs: [{ ...pr(1, ['review:human']), updatedAt }], host, nowMs,
        policy: { mode: 'units', heldStaleH: 1 } });
      expect(readout).toMatchObject({ used: 0, held: [1], breakdown: { held: { n: 1, units: 0, overflow: 0 } } });
      expect(readout.why.join(' ')).not.toContain('held stale');
    },
  );

  it('default count mode counts accepted and held PRs toward the existing 18-PR cap', () => {
    const prs = Array.from({ length: 17 }, (_, i) =>
      pr(i + 1, [i % 2 ? 'review:accepted' : 'review:human']));
    expect(assessCapacity({ prs, host })).toMatchObject({
      mode: 'count', used: 17, openCount: 17, cap: 18, verdict: 'build', slots: 1,
    });
    expect(assessCapacity({ prs: [...prs, pr(18)], host })).toMatchObject({
      mode: 'count', used: 18, cap: 18, verdict: 'deliver', slots: 0,
    });
  });

  it('charges every held PR beyond a configured heldCap at its full size weight', () => {
    const prs = [3, 1, 2].map(number => pr(number, ['review:human']));
    const readout = assessCapacity({ prs, host, policy: { mode: 'units', heldCap: 1 } });
    expect(readout).toMatchObject({
      used: 8, held: [1, 2, 3], breakdown: { held: { n: 3, units: 8, overflow: 2 } },
    });
    expect(readout.why.join(' ')).toContain('held overflow');
  });

  it.each([undefined, null, {}, 'unreadable'])(
    'unreadable PR evidence forces count mode and holds all starts: %j', prs => {
      const readout = assessCapacity({ prs, host, policy: { mode: 'units' } });
      expect(readout).toMatchObject({ mode: 'count', verdict: 'hold', slots: 0 });
      expect(readout.fallbackReason).toEqual(expect.stringMatching(/\S/));
    },
  );

  it('throwing PR evidence forces count mode and holds all starts', () => {
    const readout = assessCapacity({ host, policy: { mode: 'units' },
      get prs() { throw new Error('unreadable PR evidence'); },
    });
    expect(readout).toMatchObject({ mode: 'count', verdict: 'hold', slots: 0 });
    expect(readout.fallbackReason).toEqual(expect.stringMatching(/\S/));
  });

  it('a collector failure preserves the known PR count but holds all starts', () => {
    const readout = assessCapacity({ prs: [pr(1)], host, policy: { mode: 'units' },
      fallbackReason: 'host CPU/memory collection failed; count-mode fallback',
    });
    expect(readout).toMatchObject({
      mode: 'count', openCount: 1, used: 1, verdict: 'hold', slots: 0,
      fallbackReason: 'host CPU/memory collection failed; count-mode fallback',
    });
  });
});
