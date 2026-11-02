import { it, expect } from 'vitest';
import { resolveTimingPolicy } from '../review-timing-settings.mjs';
const resolve = overrides => resolveTimingPolicy({ env: {}, read: () => '{}', platformReview: {}, platformFix: {}, log: () => {}, ...overrides });
it('defaults both controls off with a 30 minute bound', () => {
  const result = resolve();
  expect(result.review.startBeforeCi).toBe(false);
  expect(result.fix).toMatchObject({ pushAfterCi: false, pushAfterCiMaxMin: 30 });
});
it.each(['platform', 'tool', 'env'])('resolves and logs the new leaves from %s', layer => {
  const logs = [];
  const options = { env: { WE_POLICY_CASCADE_LOG: '1' }, log: line => logs.push(line) };
  if (layer === 'platform') Object.assign(options, { platformReview: { startBeforeCi: true }, platformFix: { pushAfterCi: true, pushAfterCiMaxMin: 2 } });
  if (layer === 'tool') options.read = path => path.endsWith('review-settings.json') ? '{"startBeforeCi":true}' : '{"fix":{"pushAfterCi":true,"pushAfterCiMaxMin":2}}';
  if (layer === 'env') Object.assign(options.env, { WE_REVIEW_START_BEFORE_CI: 'true', WE_FIX_PUSH_AFTER_CI: 'true', WE_FIX_PUSH_AFTER_CI_MAX_MIN: '2' });
  const result = resolve(options);
  expect(result.review.startBeforeCi).toBe(true);
  expect(result.fix).toMatchObject({ pushAfterCi: true, pushAfterCiMaxMin: 2 });
  for (const [group, key, value] of [['review', 'startBeforeCi', true], ['fix', 'pushAfterCi', true], ['fix', 'pushAfterCiMaxMin', 2]]) {
    expect(result.sources[group][key]).toBe(layer);
    expect(logs.join('\n')).toContain(`${key}=${value} (${layer})`);
  }
});
it('uses env over tool over platform and ignores invalid values at every layer', () => {
  const result = resolve({ platformReview: { startBeforeCi: true }, platformFix: { pushAfterCi: true, pushAfterCiMaxMin: 4 },
    review: { startBeforeCi: false }, fix: { pushAfterCi: false, pushAfterCiMaxMin: 3 },
    env: { WE_REVIEW_START_BEFORE_CI: 'true', WE_FIX_PUSH_AFTER_CI: 'true', WE_FIX_PUSH_AFTER_CI_MAX_MIN: '0' } });
  expect(result.review.startBeforeCi).toBe(true);
  expect(result.fix).toMatchObject({ pushAfterCi: true, pushAfterCiMaxMin: 0 });
  const invalid = resolve({ platformReview: { startBeforeCi: 'yes' }, platformFix: { pushAfterCi: 1, pushAfterCiMaxMin: -1 },
    review: { startBeforeCi: null }, fix: { pushAfterCi: 'false', pushAfterCiMaxMin: 1.5 },
    env: { WE_REVIEW_START_BEFORE_CI: '1', WE_FIX_PUSH_AFTER_CI: 'yes', WE_FIX_PUSH_AFTER_CI_MAX_MIN: '-2' } });
  expect(invalid.review.startBeforeCi).toBe(false);
  expect(invalid.fix).toMatchObject({ pushAfterCi: false, pushAfterCiMaxMin: 30 });
});


const shadowDefaults = { earlyStartShadow: false, earlyStartCare: ['none', 'low'],
  earlyStartMaxLines: 400, earlyStartMaxFiles: 12, earlyStartKinds: ['code'] };
const shadowPlatform = { earlyStartShadow: true, earlyStartCare: ['none'],
  earlyStartMaxLines: 300, earlyStartMaxFiles: 10, earlyStartKinds: ['code', 'docs'] };
const shadowTool = { earlyStartShadow: false, earlyStartCare: ['low'],
  earlyStartMaxLines: 200, earlyStartMaxFiles: 8, earlyStartKinds: ['code', 'config'] };
const shadowEnv = { earlyStartShadow: true, earlyStartCare: ['none', 'low'],
  earlyStartMaxLines: 100, earlyStartMaxFiles: 4, earlyStartKinds: ['code', 'data'] };
const shadowEnvValues = values => Object.fromEntries(Object.entries(values).map(([key, value]) =>
  [`WE_REVIEW_${key.replace(/[A-Z]/g, c => `_${c}`).toUpperCase()}`, JSON.stringify(value)]));

it('R359 defaults early start shadow off with the bounded low-care code policy', () => {
  const result = resolve();
  expect(result.review).toMatchObject(shadowDefaults);
  for (const key of Object.keys(shadowDefaults)) expect(result.sources.review[key]).toBe('standard');
});
it.each(['standard', 'platform', 'tool', 'env'])('R359 resolves every shadow leaf and logs its provenance at %s', layer => {
  const logs = [];
  const options = { env: { WE_POLICY_CASCADE_LOG: '1' }, log: line => logs.push(line) };
  if (layer !== 'standard') options.platformReview = shadowPlatform;
  if (['tool', 'env'].includes(layer))
    options.read = path => path.endsWith('review-settings.json') ? JSON.stringify(shadowTool) : '{}';
  if (layer === 'env') Object.assign(options.env, shadowEnvValues(shadowEnv));
  const expected = { standard: shadowDefaults, platform: shadowPlatform, tool: shadowTool, env: shadowEnv }[layer];
  const result = resolve(options);
  expect(result.review).toMatchObject(expected);
  for (const [key, value] of Object.entries(expected)) {
    expect(result.sources.review[key]).toBe(layer);
    expect(logs.join('\n')).toContain(`${key}=${JSON.stringify(value)} (${layer})`);
  }
});
it('R359 rejects malformed shadow overrides and retains the lower valid layer', () => {
  const result = resolve({ platformReview: shadowPlatform,
    review: { earlyStartShadow: 'yes', earlyStartCare: 'low', earlyStartMaxLines: -1,
      earlyStartMaxFiles: 1.5, earlyStartKinds: 'code' },
    env: shadowEnvValues({ earlyStartShadow: 'true', earlyStartCare: [], earlyStartMaxLines: '400',
      earlyStartMaxFiles: -1, earlyStartKinds: [] }) });
  expect(result.review).toMatchObject(shadowPlatform);
  for (const key of Object.keys(shadowPlatform)) expect(result.sources.review[key]).toBe('platform');
});
