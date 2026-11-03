import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BUILT_IN_REVIEW_SETTINGS, defaultReviewSettingsPath, resolveReviewSettings,
  validateReviewSettings } from '../review-settings.mjs';

describe('R473 release settings', () => {
  it('defaults an omitted stage to prerelease, including historical settings', () => {
    expect(BUILT_IN_REVIEW_SETTINGS.releaseStage).toBe('prerelease');
    expect(validateReviewSettings({}).releaseStage).toBe('prerelease');
    expect(resolveReviewSettings({ fileConfig: { roundBudget: 3, scopedRereview: 'shadow' }, platform: {}, env: {} }).releaseStage).toBe('prerelease');
  });

  it('declares prerelease and a nonempty race path list in the shipped file', () => {
    const settings = JSON.parse(readFileSync(defaultReviewSettingsPath(), 'utf8'));
    expect(settings.releaseStage).toBe('prerelease');
    expect(settings.raceBlockPaths).toEqual(expect.arrayContaining([expect.any(String)]));
  });

  it.each(['prerelease', 'prod'])('accepts exact stage %s', releaseStage => {
    expect(validateReviewSettings({ releaseStage }).releaseStage).toBe(releaseStage);
    expect(resolveReviewSettings({ fileConfig: { releaseStage }, platform: {}, env: {} }).releaseStage).toBe(releaseStage);
  });

  it.each([undefined, null, '', 'preview', 'PROD', ' prerelease', 'prerelease\n', 'ｐｒｏｄ', false, 1, [], {}].map(value => [value]))(
    'fails closed to prod for an explicitly malformed stage %j', releaseStage => {
      expect(validateReviewSettings({ releaseStage }).releaseStage).toBe('prod');
      expect(resolveReviewSettings({ fileConfig: { releaseStage }, platform: {}, env: {} }).releaseStage).toBe('prod');
    });

  it('fails closed to prod for an oversized stage token', () => {
    expect(validateReviewSettings({ releaseStage: 'x'.repeat(100_000) }).releaseStage).toBe('prod');
  });

  it('accepts configured globs and directory prefixes without mutating them', () => {
    const paths = ['scripts/custom-locks/**', 'scripts/custom-reaper'];
    expect(validateReviewSettings({ raceBlockPaths: paths }).raceBlockPaths).toEqual(paths);
  });

  it.each([null, '', {}, [''], [42], ['scripts/ok/**', null]].map(value => [value]))('retains built-in protection for malformed paths %j', raceBlockPaths => {
    const defaults = BUILT_IN_REVIEW_SETTINGS.raceBlockPaths;
    expect(defaults).toEqual(expect.arrayContaining([expect.any(String)]));
    expect(validateReviewSettings({ raceBlockPaths }).raceBlockPaths).toEqual(defaults);
  });
});
