import { describe, expect, it } from 'vitest';
import { assessCapacity } from '../delivery-capacity.mjs';

const host = { idlePct: 22, memGb: 6 };
const pr = (number, labels = []) => ({
  number, labels, additions: 700, deletions: 0,
  files: ['scripts/example.mjs'], headRefName: `lane/${number}-build`,
});

describe('delivery capacity documented safety guarantees', () => {
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
