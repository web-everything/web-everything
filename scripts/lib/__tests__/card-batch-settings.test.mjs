// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  resolvePreventionBatchSettings, loadPreventionBatchSettings, formatPreventionBatchSettings,
  effectiveCardBatchPolicy, formatCardBatchSettings, loadCardBatchSettings, resolveCardBatchSettings,
} from '../card-batch-settings.mjs';
import { loadCardBatchPolicy } from '../card-batch-policy.mjs';

const standard = { enabled: true, maxCards: 10, maxAgeMinutes: 60, highPriorityBypass: true };

describe('cards.* batch settings cascade', () => {
  it('ships the operator defaults as the standard layer: batching on, 10 cards, 60 minutes', () => {
    expect(loadCardBatchPolicy().filing).toEqual(standard);
    const settings = loadCardBatchSettings({ env: {}, repo: undefined, read: () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); } });
    expect(settings).toMatchObject({ batchFiling: true, batchMaxCards: 10, batchMaxMinutes: 60, invalid: [] });
    expect(settings.sources).toEqual({ batchFiling: 'standard', batchMaxCards: 'standard', batchMaxMinutes: 'standard' });
  });

  it('a missing platform preferences file means no preference', () => {
    const settings = loadCardBatchSettings({ env: {}, repo: undefined, platformPath: '/nonexistent/delivery-platform-preferences.json' });
    expect(settings.sources.batchFiling).toBe('standard');
  });

  it('platform → repo → env: each key is answered by the highest layer that sets it validly', () => {
    const settings = resolveCardBatchSettings({
      standard,
      platform: { batchMaxCards: 4, batchMaxMinutes: 30 },
      repo: { batchMaxCards: 6 },
      env: { WE_CARDS_BATCH_MAX_MINUTES: '15' },
    });
    expect(settings).toMatchObject({ batchFiling: true, batchMaxCards: 6, batchMaxMinutes: 15 });
    expect(settings.sources).toEqual({ batchFiling: 'standard', batchMaxCards: 'repo', batchMaxMinutes: 'env' });
    expect(formatCardBatchSettings(settings)).toBe(
      'card-batch settings: cards.batchFiling=true (standard), cards.batchMaxCards=6 (repo), cards.batchMaxMinutes=15 (env)');
  });

  it('env can switch batching off', () => {
    expect(resolveCardBatchSettings({ standard, env: { WE_CARDS_BATCH_FILING: '0' } })).toMatchObject({
      batchFiling: false, sources: { batchFiling: 'env' } });
  });

  it('an invalid value is ignored and named; the layer below answers', () => {
    const settings = resolveCardBatchSettings({
      standard, platform: { batchMaxCards: 3 }, repo: { batchMaxCards: 0, batchFiling: 'yes' },
      env: { WE_CARDS_BATCH_MAX_MINUTES: '-5' },
    });
    expect(settings).toMatchObject({ batchFiling: true, batchMaxCards: 3, batchMaxMinutes: 60 });
    expect(settings.invalid).toEqual(['repo.batchFiling', 'repo.batchMaxCards', 'env.batchMaxMinutes']);
  });

  it('the effective policy preserves standard prevention when explicitly supplied', () => {
    const policy = effectiveCardBatchPolicy(resolveCardBatchSettings({ standard, repo: { batchMaxCards: 2, batchFiling: false } }),
      resolvePreventionBatchSettings({ standard: loadCardBatchPolicy().prevention }));
    expect(policy.filing).toEqual({ enabled: false, maxCards: 2, maxAgeMinutes: 60, highPriorityBypass: true });
    expect(policy.prevention).toEqual(loadCardBatchPolicy().prevention);
  });
});


describe('prevention.* batch settings cascade', () => {
  const standard = loadCardBatchPolicy().prevention;
  it('uses standard defaults without optional preferences', () => {
    const settings = loadPreventionBatchSettings({ env: {}, repo: {}, read: () => { throw new Error('missing'); } });
    expect(settings).toEqual({ batchFiling: true, batchWindowMinutes: 120, batchMaxCards: 10, batchLeaseWaitMinutes: 15, filingEnabled: true,
      sources: { batchFiling: 'standard', batchWindowMinutes: 'standard', batchMaxCards: 'standard', batchLeaseWaitMinutes: 'standard', filingEnabled: 'standard' }, invalid: [] });
  });
  it.each(['platform', 'repo', 'env'])('%s wins for each key', (layer) => {
    const layers = { standard, platform: { batchFiling: false, batchWindowMinutes: 30, batchMaxCards: 3, batchLeaseWaitMinutes: 3 } };
    if (layer !== 'platform') layers.repo = { batchFiling: true, batchWindowMinutes: 40, batchMaxCards: 4, batchLeaseWaitMinutes: 4 };
    if (layer === 'env') layers.env = { WE_PREVENTION_BATCH_FILING: 'false', WE_PREVENTION_BATCH_WINDOW_MINUTES: '50', WE_PREVENTION_BATCH_MAX_CARDS: '5', WE_PREVENTION_BATCH_LEASE_WAIT_MINUTES: '5' };
    const settings = resolvePreventionBatchSettings(layers);
    const n = { platform: 3, repo: 4, env: 5 }[layer];
    expect(settings).toMatchObject({ batchFiling: layer === 'repo', batchWindowMinutes: n * 10, batchMaxCards: n, batchLeaseWaitMinutes: n,
      sources: { batchFiling: layer, batchWindowMinutes: layer, batchMaxCards: layer, batchLeaseWaitMinutes: layer } });
  });
  it.each([['0', false], ['1', true], ['true', true], ['false', false]])('parses boolean env %s', (raw, value) => {
    expect(resolvePreventionBatchSettings({ standard, env: { WE_PREVENTION_BATCH_FILING: raw } })).toMatchObject({
      batchFiling: value, sources: { batchFiling: 'env' } });
  });
  it('ignores and reports invalid values at every layer', () => {
    const settings = resolvePreventionBatchSettings({ standard,
      platform: { batchFiling: 'yes', batchWindowMinutes: 0, batchMaxCards: 3 },
      repo: { batchWindowMinutes: 30, batchMaxCards: -1 },
      env: { WE_PREVENTION_BATCH_FILING: 'yes', WE_PREVENTION_BATCH_WINDOW_MINUTES: '1.5', WE_PREVENTION_BATCH_MAX_CARDS: '0' } });
    expect(settings).toMatchObject({ batchFiling: true, batchWindowMinutes: 30, batchMaxCards: 3 });
    expect(settings.invalid).toEqual(['platform.batchFiling', 'platform.batchWindowMinutes', 'repo.batchMaxCards',
      'env.batchFiling', 'env.batchWindowMinutes', 'env.batchMaxCards']);
    expect(formatPreventionBatchSettings(settings)).toContain('ignored invalid: platform.batchFiling');
  });
  it.each([0, -1, 1.5, '3', true, null, Number.MAX_SAFE_INTEGER + 1])('ignores invalid lease wait %j in optional layers', (value) => {
    const settings = resolvePreventionBatchSettings({ standard,
      platform: { batchLeaseWaitMinutes: value }, repo: { batchLeaseWaitMinutes: value } });
    expect(settings.batchLeaseWaitMinutes).toBe(15);
    expect(settings.sources.batchLeaseWaitMinutes).toBe('standard');
    expect(settings.invalid).toEqual(['platform.batchLeaseWaitMinutes', 'repo.batchLeaseWaitMinutes']);
  });
  it.each(['0', '-1', '1.5', 'oops', '9007199254740992'])('ignores invalid lease wait env %s and retains repo', (value) => {
    const settings = resolvePreventionBatchSettings({ standard, repo: { batchLeaseWaitMinutes: 7 },
      env: { WE_PREVENTION_BATCH_LEASE_WAIT_MINUTES: value } });
    expect(settings).toMatchObject({ batchLeaseWaitMinutes: 7, sources: { batchLeaseWaitMinutes: 'repo' },
      invalid: ['env.batchLeaseWaitMinutes'] });
  });
  it('reads the platform lease wait through the loader', () => {
    expect(loadPreventionBatchSettings({ env: {}, repo: {},
      read: () => JSON.stringify({ prevention: { batchLeaseWaitMinutes: 8 } }) }))
      .toMatchObject({ batchLeaseWaitMinutes: 8, sources: { batchLeaseWaitMinutes: 'platform' } });
  });
  it('reads the platform prevention block', () => {
    expect(loadPreventionBatchSettings({ env: {}, repo: {}, read: () => JSON.stringify({ prevention: { batchWindowMinutes: 25 } }) }))
      .toMatchObject({ batchWindowMinutes: 25, sources: { batchWindowMinutes: 'platform' } });
  });
  it('ships the operator window in declared repo settings and logs the sources', () => {
    const settings = loadPreventionBatchSettings({ env: {}, read: () => '{}' });
    expect(settings).toMatchObject({ batchFiling: true, batchWindowMinutes: 60, batchMaxCards: 25, batchLeaseWaitMinutes: 15, filingEnabled: false,
      sources: { batchFiling: 'repo', batchWindowMinutes: 'repo', batchMaxCards: 'repo', batchLeaseWaitMinutes: 'repo', filingEnabled: 'repo' } });
    expect(formatPreventionBatchSettings(settings)).toBe('prevention-batch settings: prevention.batchFiling=true (repo), prevention.batchWindowMinutes=60 (repo), prevention.batchMaxCards=25 (repo), prevention.batchLeaseWaitMinutes=15 (repo), prevention.filingEnabled=false (repo)');
    expect(effectiveCardBatchPolicy().prevention.maxAgeMinutes).toBe(60);
  });
  it('overlays prevention independently of filing and retains bypass policy', () => {
    const filing = resolveCardBatchSettings({ standard: loadCardBatchPolicy().filing });
    const prevention = resolvePreventionBatchSettings({ standard, repo: { batchFiling: false, batchWindowMinutes: 30, batchMaxCards: 4 } });
    const policy = effectiveCardBatchPolicy(filing, prevention);
    expect(policy.filing).toEqual(loadCardBatchPolicy().filing);
    expect(policy.prevention).toEqual({ enabled: false, maxAgeMinutes: 30, maxCards: 4, highPriorityBypass: true });
  });
});
