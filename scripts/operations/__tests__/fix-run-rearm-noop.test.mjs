import { describe, it, expect } from 'vitest';
import { isNothingToRearmRefusal, resolveRearmRefusalPolicy } from '../fix-run.mjs';

describe('isNothingToRearmRefusal', () => {
  it.each([
    new Error('neither review:changes nor review:accepted is live — nothing to re-arm'),
    { message: 'Command failed', stderr: Buffer.from('nothing to re-arm') },
    { message: 'Command failed', stdout: 'nothing to re-arm' },
  ])('detects the refusal in subprocess error text (%j)', (err) => {
    expect(isNothingToRearmRefusal(err)).toBe(true);
  });

  it.each([new Error('gh down'), { stderr: 'permission denied', stdout: '' }, null, undefined])('rejects other errors (%j)', (err) => {
    expect(isNothingToRearmRefusal(err)).toBe(false);
  });
});

describe('resolveRearmRefusalPolicy', () => {
  const env = { WE_PLATFORM_PREFERENCES_FILE: '/nonexistent/fix-run-rearm-policy.json' };

  it('defaults to noop and reports the standard source', () => {
    expect(resolveRearmRefusalPolicy(env)).toEqual({ mode: 'noop', source: 'standard' });
  });

  it.each(['fail', 'noop'])('accepts the %s env override and reports its source', (mode) => {
    expect(resolveRearmRefusalPolicy({ ...env, WE_FIX_REARM_NOTHING_TO_REARM: mode })).toEqual({ mode, source: 'env' });
  });

  it('ignores invalid overrides', () => {
    expect(resolveRearmRefusalPolicy({ ...env, WE_FIX_REARM_NOTHING_TO_REARM: 'invalid' })).toEqual({ mode: 'noop', source: 'standard' });
  });

  it('never throws when reading the environment fails', () => {
    const brokenEnv = { get WE_FIX_REARM_NOTHING_TO_REARM() { throw new Error('unreadable'); } };
    expect(resolveRearmRefusalPolicy(brokenEnv)).toEqual({ mode: 'noop', source: 'standard' });
  });
});
