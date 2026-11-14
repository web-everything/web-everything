import { describe, it, expect } from 'vitest';
import { constants, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveAccount, accountEnv, loadAccountMap } from '../claude-account.mjs';

const FAKE = 'fake-token-DO-NOT-LEAK-0123456789';
const MAP = {
  accounts: { a: { service: 'svc', account: 'acct-a', type: 'oauth' }, k: { service: 'svc2', account: 'acct-k', type: 'apikey' } },
  daemons: { 'com.we.build-dispatch-daemon': 'a' },
  '*': 'refuse',
  enforce: true,
};

describe('resolveAccount (pure)', () => {
  it('maps a mapped launchd label to its account', () => {
    expect(resolveAccount({ XPC_SERVICE_NAME: 'com.we.build-dispatch-daemon' }, MAP)).toEqual({ kind: 'account', account: 'a', label: 'com.we.build-dispatch-daemon' });
  });
  it.each([false, undefined, null, 1, 'true'])('enforce=%j preserves explicit mappings and ignores unmapped labels', (enforce) => {
    expect(resolveAccount({ XPC_SERVICE_NAME: 'com.we.build-dispatch-daemon' }, { ...MAP, enforce })).toEqual({ kind: 'account', account: 'a', label: 'com.we.build-dispatch-daemon' });
    expect(resolveAccount({ XPC_SERVICE_NAME: 'com.we.other' }, { ...MAP, enforce })).toEqual({ kind: 'none' });
  });
  it.each([false, undefined])('accountB=%j ignores B mappings even with enforcement enabled', (accountB) => {
    const map = { ...MAP, accounts: { b: {} }, daemons: { 'com.we.build-dispatch-daemon': 'b' }, routing: { accountB } };
    expect(resolveAccount({ XPC_SERVICE_NAME: 'com.we.build-dispatch-daemon' }, map)).toEqual({ kind: 'none' });
    expect(resolveAccount({ XPC_SERVICE_NAME: 'com.we.build-dispatch-daemon' }, { ...map, routing: undefined })).toEqual({ kind: 'none' });
  });
  it.each([null, 0, 1, '', 'false', 'true', {}, []])('malformed accountB=%j refuses B mappings', (accountB) => {
    const label = 'com.we.build-dispatch-daemon';
    const map = { ...MAP, accounts: { b: {} }, daemons: { [label]: 'b' }, routing: { accountB }, enforce: false };
    expect(resolveAccount({ XPC_SERVICE_NAME: label }, map)).toEqual({ kind: 'refuse', label });
    expect(resolveAccount({ XPC_SERVICE_NAME: label }, { ...map, routing: {} })).toEqual({ kind: 'none' });
    expect(resolveAccount({ XPC_SERVICE_NAME: label }, { ...MAP, routing: { accountB } })).toEqual({ kind: 'account', account: 'a', label });
  });
  it('accountB=true routes B independently of enforcement', () => {
    const map = { ...MAP, accounts: { b: {} }, daemons: { 'com.we.build-dispatch-daemon': 'b' }, routing: { accountB: true }, enforce: false };
    expect(resolveAccount({ XPC_SERVICE_NAME: 'com.we.build-dispatch-daemon' }, map)).toEqual({ kind: 'account', account: 'b', label: 'com.we.build-dispatch-daemon' });
  });
  it('default leaves unmapped launchd labels on their existing login', () => {
    expect(resolveAccount({ XPC_SERVICE_NAME: 'com.we.review-daemon' }, { ...MAP, '*': 'default' })).toEqual({ kind: 'none' });
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
      expect(resolveAccount({ XPC_SERVICE_NAME: label }, { ...MAP, enforce: false }).kind).toBe('none');
    }
  });
  it('empty daemons map maps nothing (PR1 behaviour)', () => {
    const empty = { accounts: MAP.accounts, daemons: {}, '*': 'refuse', enforce: false };
    expect(resolveAccount({ XPC_SERVICE_NAME: 'com.we.build-dispatch-daemon' }, empty).kind).toBe('none');
  });
  it.each([true, false])('an unknown mapped account refuses with enforce=%j', (enforce) => {
    const bad = { ...MAP, enforce, daemons: { 'com.we.x': 'zzz' } };
    expect(resolveAccount({ XPC_SERVICE_NAME: 'com.we.x' }, bad)).toEqual({ kind: 'refuse', label: 'com.we.x' });
  });
  it('a malformed map fails closed only for launchd labels, never for interactive', () => {
    expect(resolveAccount({}, null).kind).toBe('none');
  });
});

describe('accountEnv (IO, injected keychain)', () => {
  it.each(['~/.claude-account-b', '~', '/custom/claude', 'relative/claude'])('configDir %s uses only stat/access without reading login contents or Keychain and returns an absolute directory', (configDir) => {
    const calls = [];
    const m = { accounts: { b: { ...MAP.accounts.a, configDir } } };
    const expected = resolve(configDir === '~' ? homedir() : configDir.startsWith('~/') ? join(homedir(), configDir.slice(2)) : configDir);
    expect(accountEnv('b', m, { statSync: (path) => { calls.push(path); return { isDirectory: () => true, isFile: () => true, size: 1 }; }, accessSync: (path, mode) => { calls.push([path, mode]); }, readKeychain: (...args) => { calls.push(args); return FAKE; } })).toEqual({ CLAUDE_CONFIG_DIR: expected });
    expect(calls).toEqual([expected, join(expected, '.claude.json'), [join(expected, '.claude.json'), constants.R_OK]]);
  });
  it('a relative config directory selects the same profile after the worker changes cwd', () => {
    const dir = mkdtempSync(join(process.env.TMPDIR, 'claude-account-relative-'));
    try {
      writeFileSync(join(dir, '.claude.json'), '{}');
      const env = accountEnv('b', { accounts: { b: { configDir: relative(process.cwd(), dir) } } });
      expect(resolve(join(dir, 'scratch'), env.CLAUDE_CONFIG_DIR)).toBe(dir);
      expect(env.CLAUDE_CONFIG_DIR).toBe(dir);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it.each(['missing directory', 'not a directory', 'missing login file', 'login is a directory', 'login is not a regular file', 'empty login file', 'unreadable login file'])('refuses %s without exposing filesystem error contents', (failure) => {
    const dir = '/custom/claude';
    const calls = [];
    const statSync = (path) => {
      calls.push(path);
      if (failure === 'missing directory' || (path.endsWith('.claude.json') && failure === 'missing login file')) throw new Error(FAKE);
      return { isDirectory: () => failure !== 'not a directory', isFile: () => !['login is a directory', 'login is not a regular file'].includes(failure), size: failure === 'empty login file' ? 0 : 1 };
    };
    let error;
    try { accountEnv('b', { accounts: { b: { configDir: dir } } }, { statSync, accessSync: () => { if (failure === 'unreadable login file') throw new Error(FAKE); }, readKeychain: () => { throw new Error('must not fall back to Keychain'); } }); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('b');
    expect(error.message).toContain(dir);
    expect(error.message).toContain('provision the login directory before retrying');
    expect(error.stack).not.toContain(FAKE);
    expect(calls).toEqual(failure === 'missing directory' || failure === 'not a directory' ? [dir] : [dir, join(dir, '.claude.json')]);
  });
  it('uses real filesystem stats and never needs to read login contents', () => {
    const dir = mkdtempSync(join(process.env.TMPDIR, 'claude-account-'));
    const map = { accounts: { b: { configDir: join(dir, 'login') } } };
    try {
      expect(() => accountEnv('b', map)).toThrow(/account.*b/);
      mkdirSync(map.accounts.b.configDir);
      expect(() => accountEnv('b', map)).toThrow(/\.claude\.json/);
      writeFileSync(join(map.accounts.b.configDir, '.claude.json'), '');
      expect(() => accountEnv('b', map)).toThrow(/\.claude\.json/);
      writeFileSync(join(map.accounts.b.configDir, '.claude.json'), FAKE, { mode: 0o600 });
      expect(accountEnv('b', map)).toEqual({ CLAUDE_CONFIG_DIR: map.accounts.b.configDir });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
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
  it('has token account a, config-dir account b, build/fix mappings, "*" refuse, routing off and enforce false', () => {
    expect(raw.accounts.a).toMatchObject({ service: 'we.claude-code.oauth', account: 'acct-a' });
    expect(raw.accounts.b).toEqual({ configDir: '~/.claude-account-b' });
    expect(raw.daemons).toEqual({ 'com.we.build-dispatch-daemon': 'b', 'com.we.fix-dispatch-daemon': 'b' });
    expect(raw['*']).toBe('refuse');
    expect(raw.routing).toEqual({ accountB: false });
    expect(raw.enforce).toBe(false);
  });
  it('loadAccountMap reads it and fails safe on a bad path', () => {
    expect(loadAccountMap()).toEqual(raw);
    expect(loadAccountMap({ path: '/nonexistent/x.json' })).toBeNull();
  });
});
