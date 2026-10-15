import { describe, it, expect } from 'vitest';

describe('smoke real-worker cascade', () => {
  it('defaults to refusal through the standard and declared tool setting', async () => {
    const { resolveSmokeRealWorker } = await import('../smoke-real-worker.mjs');
    expect(resolveSmokeRealWorker({ env: {}, tool: {}, platform: {}, log: false })).toEqual({ allowSentinel: false, sources: { allowSentinel: 'standard' } });
    expect(resolveSmokeRealWorker({ env: {}, platform: {}, log: false })).toEqual({ allowSentinel: false, sources: { allowSentinel: 'tool' } });
  });
  it('resolves platform and tool preferences with boolean validation', async () => {
    const { resolveSmokeRealWorker } = await import('../smoke-real-worker.mjs');
    expect(resolveSmokeRealWorker({ env: {}, tool: {}, platform: { allowSentinel: true }, log: false })).toEqual({ allowSentinel: true, sources: { allowSentinel: 'platform' } });
    expect(resolveSmokeRealWorker({ env: {}, tool: { allowSentinel: true }, platform: { allowSentinel: false }, log: false })).toEqual({ allowSentinel: true, sources: { allowSentinel: 'tool' } });
    expect(resolveSmokeRealWorker({ env: {}, tool: { allowSentinel: 'true' }, platform: {}, log: false }).allowSentinel).toBe(false);
  });
  it.each([['1', true], ['true', true], ['0', false], ['false', false]])('env %s overrides the tool', async (raw, allowed) => {
    const { resolveSmokeRealWorker } = await import('../smoke-real-worker.mjs');
    expect(resolveSmokeRealWorker({ env: { WE_SMOKE_ALLOW_REAL_WORKER: raw }, tool: { allowSentinel: !allowed }, platform: {}, log: false })).toEqual({ allowSentinel: allowed, sources: { allowSentinel: 'env' } });
  });
  it('ignores invalid env values and logs cascade provenance', async () => {
    const { resolveSmokeRealWorker } = await import('../smoke-real-worker.mjs');
    const logs = [];
    expect(resolveSmokeRealWorker({ env: { WE_SMOKE_ALLOW_REAL_WORKER: 'yes', WE_POLICY_CASCADE_LOG: '1' }, tool: {}, platform: {}, log: line => logs.push(line) }).allowSentinel).toBe(false);
    expect(logs.join(' ')).toContain('smokeRealWorker: allowSentinel=false (standard)');
  });
  it.each([[900002, true], ['999998', true], [5304, false], ['90000', false], ['9000000', false], ['x900002', false], [null, false]])('identifies sentinel PR %j: %s', async (pr, expected) => {
    const { isSmokeSentinelPr } = await import('../smoke-real-worker.mjs');
    expect(isSmokeSentinelPr(pr)).toBe(expected);
  });
});
