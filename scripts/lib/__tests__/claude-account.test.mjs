import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveAccount, accountEnv, loadAccountMap } from '../claude-account.mjs';

const FAKE = 'fake-token-DO-NOT-LEAK-0123456789';
const MAP = {
  accounts: { a: { service: 'svc', account: 'acct-a', type: 'oauth' }, k: { service: 'svc2', account: 'acct-k', type: 'apikey' } },
  daemons: { 'com.we.build-dispatch-daemon': 'a' },
  '*': 'refuse',
  enforce: false,
};

describe('resolveAccount (pure)', () => {
  it('maps a mapped launchd label to its account', () => {
    expect(resolveAccount({ XPC_SERVICE_NAME: 'com.we.build-dispatch-daemon' }, MAP)).toEqual({ kind: 'account', account: 'a', label: 'com.we.build-dispatch-daemon' });
  });
  it('interactive / non-launchd env resolves to none', () => {
    expect(resolveAccount({}, MAP).kind).toBe('none');
    expect(resolveAccount({ XPC_SERVICE_NAME: '0' }, MAP).kind).toBe('none');
    expect(resolveAccount({ XPC_SERVICE_NAME: 'application.com.microsoft.VSCode.123' }, { ...MAP, enforce: true }).kind).toBe('none');
    expect(resolveAccount(undefined, MAP).kind).toBe('none');
  });
  it('unmapped com.we/com.plateau label refuses only when enforce is true', () => {
    for (const label of ['com.we.other', 'com.plateau.x']) {
      expect(resolveAccount({ XPC_SERVICE_NAME: label }, { ...MAP, enforce: true })).toEqual({ kind: 'refuse', label });
      expect(resolveAccount({ XPC_SERVICE_NAME: label }, MAP).kind).toBe('none');
    }
  });
  it('empty daemons map maps nothing (PR1 behaviour)', () => {
    const empty = { accounts: MAP.accounts, daemons: {}, '*': 'refuse', enforce: false };
    expect(resolveAccount({ XPC_SERVICE_NAME: 'com.we.build-dispatch-daemon' }, empty).kind).toBe('none');
  });
  it('a label mapped to an unknown account fails closed', () => {
    const bad = { ...MAP, daemons: { 'com.we.x': 'zzz' } };
    expect(resolveAccount({ XPC_SERVICE_NAME: 'com.we.x' }, bad).kind).toBe('refuse');
  });
  it('a malformed map fails closed only for launchd labels, never for interactive', () => {
    expect(resolveAccount({}, null).kind).toBe('none');
  });
});

describe('accountEnv (IO, injected keychain)', () => {
  it('returns the oauth token env plus scrub flag', () => {
    const calls = [];
    const env = accountEnv('a', MAP, { readKeychain: (s, a) => { calls.push([s, a]); return `${FAKE}\n`; } });
    expect(env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: FAKE, CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1' });
    expect(calls).toEqual([['svc', 'acct-a']]);
  });
  it('apikey type returns ANTHROPIC_API_KEY', () => {
    expect(accountEnv('k', MAP, { readKeychain: () => FAKE })).toEqual({ ANTHROPIC_API_KEY: FAKE, CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1' });
  });
  it('errors never contain the token value', () => {
    const boom = () => { throw new Error(`security failed ${FAKE}`); };
    let msg = '';
    try { accountEnv('a', MAP, { readKeychain: boom }); } catch (e) { msg = String(e.message) + String(e.stack); }
    expect(msg).not.toBe('');
    expect(msg).not.toContain(FAKE);
    let msg2 = '';
    try { accountEnv('a', MAP, { readKeychain: () => '' }); } catch (e) { msg2 = String(e.message); }
    expect(msg2).toMatch(/empty|no token|acct-a/i);
  });
  it('unknown account throws', () => {
    expect(() => accountEnv('nope', MAP, { readKeychain: () => FAKE })).toThrow(/unknown account/i);
  });
});

describe('claude-accounts.json shipped map', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const raw = JSON.parse(readFileSync(join(here, '..', '..', 'settings', 'claude-accounts.json'), 'utf8'));
  it('has accounts a/b, an EMPTY daemons map, "*" default and enforce false', () => {
    expect(raw.accounts.a).toMatchObject({ service: 'we.claude-code.oauth', account: 'acct-a' });
    expect(raw.accounts.b).toMatchObject({ service: 'we.claude-code.oauth', account: 'acct-b' });
    expect(raw.daemons).toEqual({});
    expect(raw['*']).toBe('refuse');
    expect(raw.enforce).toBe(false);
  });
  it('loadAccountMap reads it and fails safe on a bad path', () => {
    expect(loadAccountMap().daemons).toEqual({});
    expect(loadAccountMap({ path: '/nonexistent/x.json' })).toBeNull();
  });
});
