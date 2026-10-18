import { describe, it, expect } from 'vitest';
import { resolveCardOnlyReviewSettings } from '../review-seat-settings.mjs';

describe('review.cardOnly cascade', () => {
  const resolve = (options = {}) => {
    const logs = [];
    const result = resolveCardOnlyReviewSettings({ env: {}, platform: {}, readFile: () => '{}', log: line => logs.push(line), ...options });
    return { ...result, logs };
  };
  it('defaults to the light lane with no Claude seat and logs both sources', () => {
    expect(resolve()).toMatchObject({ value: { lightLane: true, claudeSeat: false }, sources: { lightLane: 'standard', claudeSeat: 'standard' } });
    expect(resolve().logs[0]).toContain('lightLane=true (standard), claudeSeat=false (standard)');
  });
  it('cascades each setting independently through platform, tool and env', () => {
    expect(resolve({ platform: { lightLane: false, claudeSeat: true } })).toMatchObject({ value: { lightLane: false, claudeSeat: true }, sources: { lightLane: 'platform', claudeSeat: 'platform' } });
    const readFile = () => JSON.stringify({ cardOnly: { lightLane: true, claudeSeat: false } });
    expect(resolve({ platform: { lightLane: false }, readFile, env: { WE_REVIEW_CARD_ONLY_CLAUDE_SEAT: 'true' } }))
      .toMatchObject({ value: { lightLane: true, claudeSeat: true }, sources: { lightLane: 'tool', claudeSeat: 'env' } });
    expect(resolve({ platform: { lightLane: false }, readFile: () => '{"cardOnly":{"lightLane":{}}}', env: { WE_REVIEW_CARD_ONLY_LIGHT_LANE: 'oops' } }))
      .toMatchObject({ value: { lightLane: false }, sources: { lightLane: 'platform' } });
  });
});
