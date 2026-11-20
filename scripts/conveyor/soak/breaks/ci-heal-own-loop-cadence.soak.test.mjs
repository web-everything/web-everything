import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import b, { cadenceProbe } from './ci-heal-own-loop-cadence.mjs';

// defineBreakTest uses it.fails when fixPresent is false. Cadence is now required behaviour:
// always use it so a regression cannot turn this acceptance test into an expected failure.
describe('daemon soak — break ci-heal-own-loop-cadence', () => {
  it('keeps logged gate gaps within 150 seconds through two hours of slow passes', async () => {
    const report = await b.run({});
    expect(b.judge(report)).toEqual([]);
    expect(b.fixPresent(fileURLToPath(new URL('../../../../', import.meta.url)))).toBe(true);
  });

  it('the independent log oracle rejects serial once-per-pass behaviour with a gap over ten minutes', async () => {
    const report = await cadenceProbe({ tick: async options => {
      // Fix-absent control: the original serial phase order, without passing any cooperative hook.
      options.fixTick({});
      options.ciHealTick({});
      options.hungCiTick({}); options.mainRedRebaseTick({});
      options.missingRunTick({}); options.promoteDraftTick({});
    } });
    expect(report.elapsedMs).toBe(7200000);
    expect(report.maxGapMs).toBeGreaterThan(600000);
    expect(b.judge(report).length).toBeGreaterThan(0);
  });
});
