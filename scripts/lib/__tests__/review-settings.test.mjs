import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { BUILT_IN_REVIEW_SETTINGS, defaultReviewSettingsPath, resolveReviewSettings, validateReviewSettings } from '../review-settings.mjs';

// Card 5471 [A2] — the round budget K is a declared setting under the review policy cascade
// (built-in → we:scripts/review-settings.json → env). `off` is today's behaviour; anything unreadable is `off`.
describe('review settings: roundBudget (card 5471)', () => {
  it('built-in is off (today: no budget)', () => {
    expect(BUILT_IN_REVIEW_SETTINGS.roundBudget).toBe('off');
    expect(resolveReviewSettings({ fileConfig: null, env: {} }).roundBudget).toBe('off');
  });

  it('the declared file ships K=3', () => {
    const declared = JSON.parse(readFileSync(defaultReviewSettingsPath(), 'utf8'));
    expect(declared.roundBudget).toBe(3);
    expect(validateReviewSettings(declared).roundBudget).toBe(3);
  });

  it('accepts a positive integer K from the file, and env wins over the file', () => {
    expect(resolveReviewSettings({ fileConfig: { roundBudget: 3 }, env: {} }).roundBudget).toBe(3);
    expect(resolveReviewSettings({ fileConfig: { roundBudget: 3 }, env: { WE_REVIEW_ROUND_BUDGET: '2' } }).roundBudget).toBe(2);
    expect(resolveReviewSettings({ fileConfig: { roundBudget: 3 }, env: { WE_REVIEW_ROUND_BUDGET: 'off' } }).roundBudget).toBe('off');
  });

  it.each([0, -1, 2.5, '3', 'on', null, true, 99])('an invalid file value %j keeps off (fail closed)', (bad) => {
    expect(validateReviewSettings({ roundBudget: bad }).roundBudget).toBe('off');
  });

  it.each(['0', '-2', '2.5', 'x', '', ' 3'])('an invalid env value %j keeps the file value', (bad) => {
    expect(resolveReviewSettings({ fileConfig: { roundBudget: 3 }, env: { WE_REVIEW_ROUND_BUDGET: bad } }).roundBudget).toBe(3);
  });
});

// Card 5470 [A2] — the binding prior round mode: off (today) / shadow (journal only) / on (late findings on unchanged
// code become cards). `on` is now a valid value of the existing `scopedRereview` setting.
describe('review settings: scopedRereview on (card 5470)', () => {
  it('accepts on from the file and from env', () => {
    expect(resolveReviewSettings({ fileConfig: { scopedRereview: 'on' }, env: {} }).scopedRereview).toBe('on');
    expect(resolveReviewSettings({ fileConfig: { scopedRereview: 'shadow' }, env: { WE_REVIEW_SCOPED_REREVIEW: 'on' } }).scopedRereview).toBe('on');
  });

  it('the declared file stays in shadow (ruling P3 revised: no flip planned)', () => {
    const declared = JSON.parse(readFileSync(defaultReviewSettingsPath(), 'utf8'));
    expect(declared.scopedRereview).toBe('shadow');
  });
});
