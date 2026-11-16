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


// S1 additions deliberately pin exports that do not exist until implementation phase.
import { isAccountMap, expandConfigDir, AccountRefusal, isNotApplied } from '../claude-account.mjs';

describe('isAccountMap (pure, strict shape validation)', () => {
  const dirs = { accounts: { a: { configDir: '/home/test/.claude' }, b: { configDir: '~/claude-b' } },
    daemons: { 'com.we.worker': 'b' } };
  it('accepts empty records, absolute/tilde directories and legacy keychain entries', () => {
    for (const map of [{ accounts: {}, daemons: {} }, dirs, MAP,
      { accounts: { k: { service: 'svc', account: 'acct' } }, daemons: {} }]) expect(isAccountMap(map)).toBe(true);
    for (const accountB of [undefined, true, false]) expect(isAccountMap({ ...dirs, routing: { accountB } })).toBe(true);
  });
  it.each([null, undefined, [], {}, { accounts: [], daemons: {} }, { accounts: {}, daemons: [] }].map(value => [value]))
    ('rejects unavailable and non-record maps: %j', map => expect(isAccountMap(map)).toBe(false));
  it.each(['yes', null, [], { accountB: 'true' }, { accountB: 1 }, { accountB: null }].map(value => [value]))
    ('rejects malformed routing: %j', routing => expect(isAccountMap({ ...dirs, routing })).toBe(false));
  it.each([['b'], 1, null, {}, 'unknown'].map(value => [value]))('rejects non-string or unknown daemon values: %j', value => {
    expect(isAccountMap({ ...dirs, daemons: { 'com.we.worker': value } })).toBe(false);
  });
  it.each(['relative', './profile', '../profile', '', '~other/profile', 3, null])
    ('rejects configDir without an absolute expansion: %j', configDir => {
      expect(isAccountMap({ accounts: { b: { configDir } }, daemons: {} })).toBe(false);
    });
  it.each([null, [], {}, { service: '', account: 'a' }, { service: 's', account: '  ' },
    { service: 12, account: 'a' }, { service: 's', account: 'a', type: 'bearer' }].map(value => [value]))
    ('rejects malformed keychain entries: %j', entry => {
      expect(isAccountMap({ accounts: { a: entry }, daemons: {} })).toBe(false);
    });
});

describe('expandConfigDir (pure, cwd independent)', () => {
  it('expands home and preserves filesystem path segments for realpath', () => {
    expect(expandConfigDir('~', '/home/test')).toBe('/home/test');
    expect(expandConfigDir('~/claude-b', '/home/test')).toBe('/home/test/claude-b');
    expect(expandConfigDir('/home/test/x/../claude-b/', '/elsewhere')).toBe('/home/test/x/../claude-b/');
    expect(expandConfigDir('~/x/../claude-b/', '/home/test')).toBe('/home/test/x/../claude-b/');
    expect(expandConfigDir('~/.claude', '/home/test/link/..')).toBe('/home/test/link/../.claude');
    expect(expandConfigDir('~/.claude', '/')).toBe('/.claude');
    expect(expandConfigDir('~/.claude', '/home/test/')).toBe('/home/test/.claude');
  });
  it.each([undefined, null, '', 'relative', './b', '../b', '~other/b', 12, {}])
    ('returns null instead of resolving a relative or invalid input: %j', value => {
      expect(expandConfigDir(value, '/home/test')).toBeNull();
    });
});

describe('AccountRefusal and isNotApplied', () => {
  it('carries a nonempty reason and notApplied for lane release', () => {
    const error = new AccountRefusal('map-unavailable');
    expect(error).toBeInstanceOf(Error);
    expect(error.reason).toBe('map-unavailable');
    expect(error.notApplied).toBe(true);
    expect(isNotApplied(error)).toBe(true);
  });
  it('ordinary errors and missing values do not claim notApplied', () => {
    for (const error of [new Error('failed'), undefined, null, 'failed', {}]) expect(isNotApplied(error)).toBe(false);
  });
});

describe('isAccountMap enforcement fields', () => {
  const base = { accounts: { k: { service: 'svc', account: 'acct' } }, daemons: {} };
  it('rejects a non-boolean enforce and a "*" other than refuse', () => {
    expect(isAccountMap({ ...base, enforce: 'true' })).toBe(false);
    expect(isAccountMap({ ...base, '*': 'allow' })).toBe(false);
  });
  it('accepts the shipped enforce/"*" shapes', () => {
    expect(isAccountMap({ ...base, enforce: false, '*': 'refuse' })).toBe(true);
    expect(isAccountMap({ ...base, enforce: true })).toBe(true);
  });
});
