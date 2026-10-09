// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { STANDARD_MERGE_DELIVERY, resolveMergeDeliveryPolicy, formatMergeDeliverySourcesLine, loadMergeDeliveryPolicy } from '../merge-delivery-policy.mjs';

describe('merge delivery policy cascade', () => {
  it('uses standard defaults without layers', () => {
    const policy = resolveMergeDeliveryPolicy();
    expect(policy).toMatchObject(STANDARD_MERGE_DELIVERY);
    expect(policy.strategy).toBe('drain-direct');
    expect(policy.sources).toEqual({ strategy: 'standard', batchSize: 'standard', maxGroupWaitMinutes: 'standard', mergeMethod: 'standard' });
    expect(policy.invalid).toEqual([]);
  });

  it('resolves each key independently, with tool overriding platform', () => {
    const platform = { strategy: 'github-merge-queue', batchSize: 3 };
    expect(resolveMergeDeliveryPolicy({ platform })).toMatchObject({
      strategy: 'github-merge-queue', batchSize: 3, sources: { strategy: 'platform', batchSize: 'platform' },
    });
    expect(resolveMergeDeliveryPolicy({ platform, tool: { strategy: 'drain-direct' } })).toMatchObject({
      strategy: 'drain-direct', batchSize: 3, sources: { strategy: 'tool', batchSize: 'platform' }, invalid: [],
    });
  });

  it('reports invalid tool values and falls through to platform', () => {
    const policy = resolveMergeDeliveryPolicy({ platform: { strategy: 'github-merge-queue', batchSize: 3 }, tool: { strategy: 'yolo', batchSize: 0 } });
    expect(policy).toMatchObject({ strategy: 'github-merge-queue', batchSize: 3, sources: { strategy: 'platform', batchSize: 'platform' } });
    expect(policy.invalid).toEqual(['tool.strategy="yolo"', 'tool.batchSize=0']);
  });

  it.each([
    ['drain-direct', 'merge-gate', false],
    ['drain-direct', 'drain', true],
    ['drain-direct', 'both', true],
    ['github-merge-queue', 'merge-gate', true],
    ['github-merge-queue', 'drain', false],
    ['github-merge-queue', 'both', true],
  ])('validates %s placement %s (valid: %s)', (strategy, placement, valid) => {
    const policy = resolveMergeDeliveryPolicy({ tool: { strategy, gatePlacement: { codeql: placement } }, knownGates: ['codeql'] });
    expect(policy.gatePlacement).toEqual(valid ? { codeql: placement } : {});
    expect(policy.invalid).toEqual(valid ? [] : [expect.stringContaining('tool.gatePlacement.codeql')]);
    if (valid) expect(policy.sources['gatePlacement.codeql']).toBe('tool');
  });

  it('rejects an unknown gate when a roster is supplied', () => {
    const policy = resolveMergeDeliveryPolicy({ tool: { gatePlacement: { unknown: 'both' } }, knownGates: ['codeql'] });
    expect(policy.gatePlacement).toEqual({});
    expect(policy.invalid).toEqual(['tool.gatePlacement.unknown: unknown gate']);
  });

  it('revalidates platform placements against the final tool strategy', () => {
    const policy = resolveMergeDeliveryPolicy({ platform: { strategy: 'drain-direct', gatePlacement: { codeql: 'drain' } }, tool: { strategy: 'github-merge-queue' } });
    expect(policy.strategy).toBe('github-merge-queue');
    expect(policy.gatePlacement).toEqual({});
    expect(policy.sources).not.toHaveProperty('gatePlacement.codeql');
    expect(policy.invalid).toEqual([expect.stringContaining('platform.gatePlacement.codeql=drain')]);
  });

  it('formats every effective key with its source', () => {
    const policy = resolveMergeDeliveryPolicy({ platform: { batchSize: 3 }, tool: { mergeMethod: 'squash', gatePlacement: { codeql: 'both' } } });
    const line = formatMergeDeliverySourcesLine(policy);
    for (const key of ['strategy', 'batchSize', 'maxGroupWaitMinutes', 'mergeMethod']) {
      expect(line).toContain(`${key}=${policy[key]} (${policy.sources[key]})`);
    }
    expect(line).toContain('gatePlacement.codeql=both (tool)');
  });
});

describe('loadMergeDeliveryPolicy', () => {
  it('loads the platform mergeDelivery block through injected IO', () => {
    const reads = [];
    const policy = loadMergeDeliveryPolicy({ toolSettings: {}, readFile: (...args) => {
      reads.push(args);
      return '{"mergeDelivery":{"strategy":"github-merge-queue"}}';
    } });
    expect(reads).toHaveLength(1);
    expect(reads[0][1]).toBe('utf8');
    expect(policy).toMatchObject({ strategy: 'github-merge-queue', sources: { strategy: 'platform' }, invalid: [] });
  });

  it('treats ENOENT as an unset platform layer', () => {
    const policy = loadMergeDeliveryPolicy({ toolSettings: {}, readFile: () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); } });
    expect(policy).toEqual(resolveMergeDeliveryPolicy());
  });

  it('reports other read failures and retains standard defaults', () => {
    const policy = loadMergeDeliveryPolicy({ toolSettings: {}, readFile: () => { throw Object.assign(new Error('permission denied'), { code: 'EACCES' }); } });
    expect(policy).toMatchObject({ strategy: 'drain-direct', sources: { strategy: 'standard' } });
    expect(policy.invalid).toEqual(['platform file unreadable: permission denied']);
  });

  it('keeps the committed platform strategy drain-direct', () => {
    const platform = JSON.parse(readFileSync(new URL('../delivery-platform-preferences.json', import.meta.url), 'utf8'));
    expect(resolveMergeDeliveryPolicy({ platform: platform.mergeDelivery }).strategy).toBe('drain-direct');
  });
});
