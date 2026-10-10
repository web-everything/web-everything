import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolveGithubAuthPolicy, personalAllowed, readGithubAuthPolicy } from '../github-auth-policy.mjs';

describe('GitHub auth policy', () => {
  it('defaults to App auth with no personal exceptions', () => {
    expect(resolveGithubAuthPolicy()).toEqual({ auth: 'app', personalExceptions: {}, source: { auth: 'default' } });
  });

  it.each([
    [{ auth: 'personal' }, {}, 'personal', 'tool'],
    [{ auth: 'personal' }, { WE_GITHUB_AUTH: 'app' }, 'app', 'env'],
    [{ auth: 'invalid' }, {}, 'app', 'default'],
    [{ auth: 'personal' }, { WE_GITHUB_AUTH: 'invalid' }, 'personal', 'tool'],
  ])('resolves tool %j and env %j to %s from %s', (tool, env, auth, source) => {
    expect(resolveGithubAuthPolicy({ tool, env })).toEqual({ auth, personalExceptions: {}, source: { auth: source } });
  });

  it('merges trimmed env exception names while preserving tool reasons', () => {
    expect(resolveGithubAuthPolicy({
      tool: { personalExceptions: { 'main-push': 'SSH only', legacy: 'tool reason' } },
      env: { WE_GITHUB_AUTH_PERSONAL_EXCEPTIONS: 'reads, main-push' },
    }).personalExceptions).toEqual({
      'main-push': 'SSH only', legacy: 'tool reason', reads: 'env WE_GITHUB_AUTH_PERSONAL_EXCEPTIONS',
    });
  });

  it('ignores a non-object exceptions layer', () => {
    expect(resolveGithubAuthPolicy({ tool: { personalExceptions: ['reads'] } }).personalExceptions).toEqual({});
  });

  it('allows any caller under personal auth and only listed names under App auth', () => {
    expect(personalAllowed({ auth: 'personal' }, 'unlisted')).toBe(true);
    const policy = { auth: 'app', personalExceptions: { reads: 'explicit exception' } };
    expect(personalAllowed(policy, 'reads')).toBe(true);
    expect(personalAllowed(policy, 'unlisted')).toBe(false);
    expect(personalAllowed(policy, 'toString')).toBe(false);
    expect(personalAllowed(null, 'reads')).toBe(false);
  });

  it('reads the github settings section through the injected reader', () => {
    expect(readGithubAuthPolicy({ read: () => ({ github: { auth: 'personal' } }), env: {} }))
      .toEqual({ auth: 'personal', personalExceptions: {}, source: { auth: 'tool' } });
  });

  it('falls back to defaults when settings cannot be read', () => {
    expect(readGithubAuthPolicy({ read: () => { throw new Error('unreadable'); }, env: {} }))
      .toEqual({ auth: 'app', personalExceptions: {}, source: { auth: 'default' } });
  });

  it('ships App auth without the personal reads exception', () => {
    const settings = JSON.parse(readFileSync('scripts/settings/github-auth.json', 'utf8'));
    expect(settings.github.auth).toBe('app');
    expect(settings.github.personalExceptions ?? {}).not.toHaveProperty('reads');
  });
});
