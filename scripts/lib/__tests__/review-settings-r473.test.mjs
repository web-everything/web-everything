import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { URL as NodeURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BUILT_IN_REVIEW_SETTINGS, defaultReviewSettingsPath, resolveReviewSettings,
  resolveAuditSettings, resolveReviewSettingSource, validateReviewSettings } from '../review-settings.mjs';

describe('R473 release settings', () => {
  it.each([
    [{ releaseStage: 'prod' }, {}, 'prerelease', 'prod', 'tool'],
    [{}, { releaseStage: 'prod' }, 'prerelease', 'prod', 'platform'],
    [{ releaseStage: 'invalid' }, {}, 'prerelease', 'prod', 'tool'],
    [{ releaseStage: 'prerelease' }, {}, 'prod', 'prod', 'env'],
    [{ releaseStage: 'prerelease' }, {}, 'prerelease', 'prerelease', 'env'],
  ])('env only tightens configured stage: file=%j platform=%j env=%s', (fileConfig, platform, stage, expected, source) => {
    const env = { WE_REVIEW_RELEASE_STAGE: stage };
    expect(resolveAuditSettings({ fileConfig, platform, env })).toMatchObject({
      value: { releaseStage: expected }, sources: { releaseStage: source },
    });
    expect(resolveReviewSettings({ fileConfig, platform, env }).releaseStage).toBe(expected);
    expect(resolveReviewSettingSource('releaseStage', { fileRaw: fileConfig, platform, env })).toBe(source);
  });

  const readers = [
    ['file loader', 'settings.loadReviewSettingsFile().releaseStage'],
    ['review resolver', 'settings.resolveReviewSettings({ platform: {}, env: {} }).releaseStage'],
    ['audit resolver', 'settings.resolveAuditSettings({ platform: {}, env: {} }).value.releaseStage'],
  ];
  // Exercise native ESM imports as well as Vitest consumers without touching the shipped file.
  const readWith = (expression, mode) => {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import * as settings from ${JSON.stringify(new NodeURL('../review-settings.mjs', import.meta.url).href)};
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      fs.readFileSync = () => {
        const mode = ${JSON.stringify(mode)};
        if (mode === 'invalid JSON') return '{broken';
        if (mode === 'historical') return '{"roundBudget":3}';
        throw Object.assign(new Error('Cannot read settings'), { code: mode });
      };
      syncBuiltinESMExports();
      process.stdout.write(JSON.stringify(${expression}));
    `], { encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024 });
    expect(child.status, child.stderr).toBe(0);
    return JSON.parse(child.stdout);
  };
  describe.each(readers)('%s', (_name, readStage) => {
    it.each(['ENOENT', 'EACCES', 'invalid JSON'])('fails closed to prod when settings cannot be read: %s', mode => {
      expect(readWith(readStage, mode)).toBe('prod');
    });

    it('keeps prerelease for a readable historical file without releaseStage', () => {
      expect(readWith(readStage, 'historical')).toBe('prerelease');
    });
  });

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
