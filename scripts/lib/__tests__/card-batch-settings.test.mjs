// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
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

  it('the effective policy overlays only the filing kind', () => {
    const policy = effectiveCardBatchPolicy(resolveCardBatchSettings({ standard, repo: { batchMaxCards: 2, batchFiling: false } }));
    expect(policy.filing).toEqual({ enabled: false, maxCards: 2, maxAgeMinutes: 60, highPriorityBypass: true });
    expect(policy.prevention).toEqual(loadCardBatchPolicy().prevention);
  });
});
