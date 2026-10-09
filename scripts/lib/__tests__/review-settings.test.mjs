import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  BUILT_IN_REVIEW_SETTINGS, defaultReviewSettingsPath, isValidRoundBudget, resolveReviewSettings, ROUND_BUDGET_MAX, validateReviewSettings,
} from '../review-settings.mjs';

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

  it.each(['0', '-2', '2.5', 'x', '', ' 3', '007', '99999999999999999999'])('an invalid env value %j keeps the file value', (bad) => {
    expect(resolveReviewSettings({ fileConfig: { roundBudget: 3 }, env: { WE_REVIEW_ROUND_BUDGET: bad } }).roundBudget).toBe(3);
  });

  // PR #4714 review: ONE contract for both layers — the file and the env accept the same range (1..ROUND_BUDGET_MAX).
  it('the file and the env agree at the boundary: 50 is valid, 51 and 75 are not, in BOTH layers', () => {
    expect(ROUND_BUDGET_MAX).toBe(50);
    for (const [fileValue, envValue, want] of [[50, '50', 50], [51, '51', 'off'], [75, '75', 'off'], [99, '99', 'off'], [1, '1', 1]]) {
      expect(validateReviewSettings({ roundBudget: fileValue }).roundBudget).toBe(want);
      expect(resolveReviewSettings({ fileConfig: null, env: { WE_REVIEW_ROUND_BUDGET: envValue } }).roundBudget).toBe(want);
    }
    expect(resolveReviewSettings({ fileConfig: { roundBudget: 3 }, env: { WE_REVIEW_ROUND_BUDGET: '75' } }).roundBudget).toBe(3);
  });

  it('every consumer of K shares the bound: the replay tool refuses an out-of-range K, the runtime resolver treats it as off', async () => {
    const { main } = await import('../../operations/review-round-replay.mjs');
    for (const bad of ['0', '51', '75', 'x', '', '0x3', '3e0', '03', ' 3', '3.0']) expect(() => main([`--round-budget=${bad}`, '--runs-dir=/nonexistent'], { log: () => {} })).toThrow(/--round-budget must be an integer from 1 to 50/);
    // A bare `--round-budget` (no value) parses as `true`, which `Number()` turns into 1.
    expect(() => main(['--round-budget', '--runs-dir=/nonexistent'], { log: () => {} })).toThrow(/--round-budget must be an integer/);
    const { resolveRoundBudget } = await import('../../operations/review-pr-io.mjs');
    expect(resolveRoundBudget(75, { settings: () => ({ roundBudget: 75 }) })).toBe('off');
    expect(resolveRoundBudget(null, { settings: () => ({ roundBudget: 51 }) })).toBe('off');
    expect(resolveRoundBudget(50, { settings: () => ({ roundBudget: 'off' }) })).toBe(50);
    const { roundBudgetDecision } = await import('../review-loop-policy.mjs');
    expect(roundBudgetDecision({ verdict: {}, round: 4, budget: 75 }).k).toBeNull();
  }, 60_000); // imports the whole review IO shell

  it('isValidRoundBudget is the one predicate every consumer shares', () => {
    for (const ok of [1, 3, 50]) expect(isValidRoundBudget(ok)).toBe(true);
    for (const bad of [0, -1, 51, 2.5, '3', null, undefined, true, NaN, Infinity, 'off']) expect(isValidRoundBudget(bad)).toBe(false);
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
