import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultListAgents, revokeDispatchTrust } from '../dispatch-lane-io.mjs';
import { markWorkerEnv } from '../session-role.mjs';
import { stopSession } from '../dispatch-abort.mjs';
import { acquireFixDispatchClaim, fixDispatchSessionName, refreshLiveFixDispatchClaims } from '../../conveyor/fix-dispatch-claim.mjs';
import * as claudeAccount from '../../lib/claude-account.mjs';

describe('account switch lifecycle', () => {
  const options = () => ({ map: { accounts: { b: { configDir: '/b' } }, daemons: {}, routing: { accountB: false } },
    statSync: () => ({ isDirectory: () => true, isFile: () => true, size: 2 }), accessSync: () => {} });

  it.each(['full', 'unique-short', 'ambiguous-short', 'duplicate-full', 'missing'])('resolves %s IDs before stopping exactly one profile', (kind) => {
    const a = '12345678-1111-4111-8111-111111111111';
    const b = kind === 'duplicate-full' ? a : '12345678-2222-4222-8222-222222222222';
    const jobs = new Map([['/a', [{ sessionId: a }]], ['/b', [{ sessionId: b }]]]);
    const stops = [];
    const exec = (_cmd, argv, opts) => {
      const profile = opts.env.CLAUDE_CONFIG_DIR || opts.env.HOME;
      if (argv[0] === 'agents') return JSON.stringify(jobs.get(profile));
      stops.push([profile, argv[1]]);
      jobs.set(profile, jobs.get(profile).filter(row => !row.sessionId.startsWith(argv[1])));
      return 'stopped';
    };
    const id = kind === 'unique-short' ? '12345678-1' : kind === 'ambiguous-short' ? '12345678' : kind === 'missing' ? 'missing' : a;
    const stop = () => stopSession({ handle: id, env: { HOME: '/a' }, exec, accountOptions: options() });
    if (['ambiguous-short', 'duplicate-full'].includes(kind)) {
      expect(stop).toThrow(/ambiguous/i);
      expect(stops).toEqual([]);
    } else if (kind === 'missing') {
      expect(stop()).toMatchObject({ alreadyGone: true, output: expect.stringMatching(/no.*matching/i) });
      expect(stops).toEqual([]);
    } else {
      expect(stop()).toMatchObject({ stopped: true, alreadyGone: false });
      expect(stops).toEqual([['/a', a]]);
      expect(jobs.get('/b')).toEqual([{ sessionId: b }]);
    }
  });

  it.each(['explicit-default', 'symlink-default', 'symlink-mapped'])('lists each real store once for %s', (kind) => {
    const home = mkdtempSync(join(tmpdir(), 'session-realpath-'));
    try {
      const store = join(home, '.claude');
      const alias = join(home, 'alias');
      mkdirSync(store);
      writeFileSync(join(store, '.claude.json'), '{}');
      symlinkSync(store, alias, 'dir');
      const map = { accounts: { b: { configDir: kind === 'symlink-mapped' ? alias : store } }, daemons: {}, routing: { accountB: false } };
      const exec = vi.fn(() => '[{"sessionId":"one-session"}]');
      expect(defaultListAgents({ env: { HOME: home, CLAUDE_CONFIG_DIR: kind === 'symlink-default' ? alias : store,
        WE_CLAUDE_AGENTS_CACHE_TTL_MS: '0' }, exec, accountOptions: { map } })).toEqual([{ sessionId: 'one-session' }]);
      expect(exec).toHaveBeenCalledTimes(1);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('resolves a CLI short ID unrelated to the UUID, normalizes case and dedupes repeated rows', () => {
    const fullId = 'abcdefab-1111-4111-8111-111111111111';
    const row = { id: ' DEADBEEF ', sessionId: fullId.toUpperCase() };
    const exec = vi.fn((_cmd, args, opts) => args[0] === 'agents'
      ? JSON.stringify(opts.env.CLAUDE_CONFIG_DIR ? [] : [row, row]) : 'stopped');
    expect(stopSession({ handle: ' DEADBEEF ', env: { HOME: '/a' }, exec, accountOptions: options() }).alreadyGone).toBe(false);
    expect(exec.mock.calls.filter(([, args]) => args[0] === 'stop').map(([, args]) => args)).toEqual([['stop', fullId]]);
  });

  it('refuses two distinct UUIDs matching a short ID inside a single profile', () => {
    const exec = vi.fn(() => JSON.stringify([
      { id: 'shared', sessionId: '11111111-1111-4111-8111-111111111111' },
      { id: 'shared', sessionId: '22222222-2222-4222-8222-222222222222' },
    ]));
    expect(() => stopSession({ handle: 'shared', env: { HOME: '/a' }, exec,
      accountOptions: { map: { accounts: {}, daemons: {} } } })).toThrow(/ambiguous/);
    expect(exec.mock.calls.every(([, args]) => args[0] === 'agents')).toBe(true);
  });

  it.each(['', '{}', '[{}]', 'null', 'timeout'])('does not interpret invalid listing %j as absence', (response) => {
    const exec = vi.fn((_cmd, args, opts) => {
      expect(args).toEqual(['agents', '--json', '--all']);
      expect(opts).toMatchObject({ timeout: 30_000, maxBuffer: 8 * 1024 * 1024, killSignal: 'SIGKILL' });
      if (response === 'timeout') throw new Error('timed out');
      return response;
    });
    expect(() => stopSession({ handle: 'missing', env: { HOME: '/a' }, exec,
      accountOptions: { map: { accounts: {}, daemons: {} } } })).toThrow(/failed/);
  });

  it('requires complete profile evidence for short IDs while allowing a full UUID in readable A', () => {
    const fullId = 'abcdefab-1111-4111-8111-111111111111';
    const exec = vi.fn((_cmd, args, opts) => {
      if (args[0] === 'agents') {
        if (opts.env.CLAUDE_CONFIG_DIR) throw new Error('B listing unavailable');
        return JSON.stringify([{ id: 'abcdefab', sessionId: fullId }]);
      }
      return 'stopped';
    });
    const stop = handle => stopSession({ handle, env: { HOME: '/a' }, exec, accountOptions: options() });
    expect(() => stop('abcdefab')).toThrow(/cannot resolve short/);
    expect(exec.mock.calls.every(([, args]) => args[0] === 'agents')).toBe(true);
    expect(stop(fullId)).toMatchObject({ stopped: true, alreadyGone: false });
    expect(exec.mock.calls.filter(([, args]) => args[0] === 'stop')).toHaveLength(1);
  });

  it('uses fresh ownership evidence even when the all-sessions discovery cache says absent', () => {
    const home = mkdtempSync(join(tmpdir(), 'session-stop-cache-'));
    try {
      const env = { HOME: home, WE_CLAUDE_AGENTS_CACHE_TTL_MS: '60000' };
      const accountOptions = { map: { accounts: {}, daemons: {} } };
      expect(defaultListAgents({ env, accountOptions, all: true, exec: () => '[]' })).toEqual([]);
      const exec = vi.fn((_cmd, args) => args[0] === 'agents' ? '[{"sessionId":"live-session"}]' : 'stopped');
      expect(stopSession({ handle: 'live-session', env, accountOptions, exec }).alreadyGone).toBe(false);
      expect(exec.mock.calls.map(([, args]) => args[0])).toEqual(['agents', 'stop']);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('cannot use a default-store symlink to bypass a mapped profile with missing login', () => {
    const home = mkdtempSync(join(tmpdir(), 'session-invalid-alias-'));
    try {
      const store = join(home, '.claude');
      const alias = join(home, 'alias');
      mkdirSync(store);
      symlinkSync(store, alias, 'dir');
      const accountOptions = { map: { accounts: { b: { configDir: alias } }, daemons: {}, routing: { accountB: false } } };
      const exec = vi.fn();
      expect(() => stopSession({ handle: 'missing', env: { HOME: home, CLAUDE_CONFIG_DIR: store }, accountOptions, exec })).toThrow(/unavailable/);
      expect(exec).not.toHaveBeenCalled();
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it.each([
    null, false, 1, 'secret-map-content', [], {},
    { accounts: [], daemons: {} }, { accounts: {}, daemons: [] },
    { accounts: null, daemons: {} }, { accounts: {}, daemons: null },
    { accounts: { b: null }, daemons: {} },
    { accounts: { b: [] }, daemons: {} },
    { accounts: { b: {} }, daemons: {} },
    { accounts: { a: { service: 'svc' } }, daemons: {} },
    { accounts: { a: { service: 'svc', account: 'acct', type: 'unknown' } }, daemons: {} },
    { accounts: { b: { configDir: '' } }, daemons: {} },
    { accounts: { b: { configDir: '  ' } }, daemons: {} },
    { accounts: { b: { configDir: ['secret-map-content'] } }, daemons: {} },
    { accounts: { b: { configDir: '/b' } }, daemons: { 'com.we.x': ['b'] } },
    { accounts: {}, daemons: { 'com.we.x': 'missing' } },
    { accounts: {}, daemons: {}, routing: [] },
    { accounts: {}, daemons: {}, routing: { accountB: 'true' } },
  ].map(map => ({ map })))('invalid account map $map refuses discovery and stop before inherited-profile IO', ({ map }) => {
    const loader = vi.spyOn(claudeAccount, 'loadAccountMap').mockReturnValue(map);
    const exec = vi.fn(() => 'No job matching');
    try {
      for (const env of [{ HOME: '/a' }, { HOME: '/a', XPC_SERVICE_NAME: 'com.we.fix-dispatch-daemon' }]) {
        for (const accountOptions of [undefined, { map }]) {
          for (const operation of [
            () => defaultListAgents({ env, exec, accountOptions }),
            () => stopSession({ handle: 'b-session', env, exec, accountOptions }),
          ]) {
            expect(operation).toThrow(/account map unavailable.*repair.*claude-accounts\.json/i);
            try { operation(); } catch (error) { expect(error.stack).not.toContain('secret-map-content'); }
          }
        }
      }
      expect(exec).not.toHaveBeenCalled();
    } finally { loader.mockRestore(); }
  });

  it('missing, unreadable and corrupt map files cannot reuse cached session evidence and recover on the next read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'account-map-failure-'));
    const path = join(dir, 'map.json');
    const load = claudeAccount.loadAccountMap;
    const loader = vi.spyOn(claudeAccount, 'loadAccountMap').mockImplementation(() => load({ path }));
    const env = { HOME: dir, WE_CLAUDE_AGENTS_CACHE_TTL_MS: '60000' };
    const exec = vi.fn(() => '[{"sessionId":"a"}]');
    const valid = JSON.stringify({ accounts: {}, daemons: {} });
    try {
      writeFileSync(path, valid);
      expect(defaultListAgents({ env, exec })).toEqual([{ sessionId: 'a' }]);
      expect(exec).toHaveBeenCalledTimes(1);
      for (const broken of ['missing', 'directory', 'truncated', 'null']) {
        rmSync(path, { recursive: true, force: true });
        if (broken === 'directory') mkdirSync(path); // deterministic read failure, even with privileged runners
        if (broken === 'truncated') writeFileSync(path, '{"secret-map-content":');
        if (broken === 'null') writeFileSync(path, 'null');
        expect(() => defaultListAgents({ env, exec })).toThrow(/account map unavailable/);
        expect(() => stopSession({ handle: 'b-session', env, exec })).toThrow(/account map unavailable/);
        expect(exec).toHaveBeenCalledTimes(1);
        rmSync(path, { recursive: true, force: true });
        writeFileSync(path, valid);
        expect(defaultListAgents({ env, exec })).toEqual([{ sessionId: 'a' }]);
      }
    } finally {
      loader.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an unmapped observer retains explicit A, default A and provisioned B after rollback', () => {
    const env = { HOME: '/home-a', CLAUDE_CONFIG_DIR: '/explicit-a', WE_CLAUDE_AGENTS_CACHE_TTL_MS: '0' };
    const rows = defaultListAgents({ env, accountOptions: options(),
      exec: (_cmd, _args, opts) => JSON.stringify([{ sessionId: opts.env.CLAUDE_CONFIG_DIR || opts.env.HOME }]) });
    expect(rows.map(row => row.sessionId)).toEqual(['/explicit-a', '/home-a', '/b']);
  });

  it.each(['timeout', 'malformed', 'wrong-shape'])('never returns a partial listing when B has a %s failure', (failure) => {
    const env = { HOME: '/a', WE_CLAUDE_AGENTS_CACHE_TTL_MS: '0' };
    const calls = [];
    expect(() => defaultListAgents({ env, accountOptions: options(), exec: (_cmd, _args, opts) => {
      calls.push(opts.env.CLAUDE_CONFIG_DIR || opts.env.HOME);
      if (!opts.env.CLAUDE_CONFIG_DIR) return '[{"sessionId":"a"}]';
      if (failure === 'timeout') throw new Error('timed out');
      return failure === 'malformed' ? '{' : '{}';
    } })).toThrow();
    expect(calls).toEqual(['/a', '/b']);
  });

  it('a confirmed absence in A cannot hide a stop failure in B', () => {
    const calls = [];
    expect(() => stopSession({ handle: 'b-session', env: { HOME: '/a' }, accountOptions: options(),
      exec: (_cmd, args, opts) => {
        calls.push(opts.env.CLAUDE_CONFIG_DIR || opts.env.HOME);
        if (args[0] === 'agents') return JSON.stringify(opts.env.CLAUDE_CONFIG_DIR ? [{ sessionId: 'b-session' }] : []);
        throw Object.assign(new Error('failed'), { stderr: 'permission denied' });
      },
    })).toThrow(/permission denied/);
    expect(calls).toEqual(['/a', '/b', '/b']);
  });

  it('every account with a config directory is discovered and stopped, not only B', () => {
    const map = { accounts: { b: { configDir: '/b' }, c: { configDir: '/c' } }, daemons: { 'com.we.x': 'c' }, routing: { accountB: false } };
    const accountOptions = { ...options(), map };
    const env = { HOME: '/a', WE_CLAUDE_AGENTS_CACHE_TTL_MS: '0' };
    const rows = defaultListAgents({ env, accountOptions, exec: (_cmd, _args, opts) => JSON.stringify([{ sessionId: opts.env.CLAUDE_CONFIG_DIR || opts.env.HOME }]) });
    expect(rows.map(row => row.sessionId)).toEqual(['/a', '/b', '/c']);
    const exec = (_cmd, argv, opts) => {
      if (argv[0] === 'agents') return JSON.stringify(opts.env.CLAUDE_CONFIG_DIR === '/c' ? [{ sessionId: 'c-session' }] : []);
      expect(opts.env.CLAUDE_CONFIG_DIR).toBe('/c');
      return 'stopped';
    };
    expect(stopSession({ handle: 'c-session', env, exec, accountOptions })).toMatchObject({ stopped: true, alreadyGone: false });
  });

  it.each(['missing-login', 'unreadable-dir'])('a broken B profile (%s) never blocks stopping a live A job, and never reads as already gone', (broken) => {
    const map = { accounts: { b: { configDir: '/b' } }, daemons: {}, routing: { accountB: false } };
    const statSync = (path) => {
      if (broken === 'unreadable-dir') throw Object.assign(new Error('denied'), { code: 'EACCES' });
      if (path.endsWith('.claude.json')) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); // directory present, login gone
      return { isDirectory: () => true };
    };
    const env = { HOME: '/a' };
    const stops = [];
    const live = (_cmd, argv, opts) => {
      if (argv[0] === 'agents') return '[{"sessionId":"a-session"}]';
      stops.push(opts.env.CLAUDE_CONFIG_DIR || opts.env.HOME);
      if (opts.env.CLAUDE_CONFIG_DIR) throw Object.assign(new Error('gone'), { stderr: 'No job matching' });
      return 'stopped';
    };
    expect(stopSession({ handle: 'a-session', env, exec: live, accountOptions: { map, statSync } })).toMatchObject({ stopped: true, alreadyGone: false });
    expect(stops[0]).toBe('/a');
    expect(stops).toEqual(['/a']); // the broken profile is never asked
    // Absence everywhere readable is still not "already gone" while B is unknown; listings stay complete-or-throw.
    const gone = () => { throw Object.assign(new Error('gone'), { stderr: 'No job matching' }); };
    expect(() => stopSession({ handle: 'x', env, exec: gone, accountOptions: { map, statSync } })).toThrow(/unavailable/);
    expect(() => defaultListAgents({ env: { ...env, WE_CLAUDE_AGENTS_CACHE_TTL_MS: '0' }, exec: () => '[]', accountOptions: { map, statSync } })).toThrow(/unavailable/);
  });

  it('a trailing slash or ~ form of the same directory is one job store', () => {
    const map = { accounts: { b: { configDir: '/b' } }, daemons: {}, routing: { accountB: false } };
    const calls = [];
    defaultListAgents({ env: { HOME: '/a', CLAUDE_CONFIG_DIR: '/b/', WE_CLAUDE_AGENTS_CACHE_TTL_MS: '0' },
      accountOptions: { ...options(), map },
      exec: (_cmd, _args, opts) => { calls.push(opts.env.CLAUDE_CONFIG_DIR || opts.env.HOME); return '[]'; } });
    expect(calls).toEqual(['/b/', '/a']);
  });

  it.each(['missing-login', 'empty-login'])('a broken B profile (%s) cannot block the reaper from revoking A trust', (broken) => {
    const dir = mkdtempSync(join(tmpdir(), 'account-revoke-'));
    const home = join(dir, 'home');
    const b = join(dir, 'b');
    const cwd = join(dir, 'scratch');
    const saved = Object.fromEntries(['HOME', 'CLAUDE_CONFIG_DIR', 'WE_DISPATCH_TRUST_PATH', 'XPC_SERVICE_NAME'].map(k => [k, process.env[k]]));
    try {
      mkdirSync(home);
      mkdirSync(b);
      if (broken === 'empty-login') writeFileSync(join(b, '.claude.json'), '');
      const trusted = JSON.stringify({ projects: { [cwd]: { hasTrustDialogAccepted: true } }, keep: 1 });
      writeFileSync(join(home, '.claude.json'), trusted);
      process.env.HOME = home;
      for (const k of ['CLAUDE_CONFIG_DIR', 'WE_DISPATCH_TRUST_PATH', 'XPC_SERVICE_NAME']) delete process.env[k];
      const map = { accounts: { b: { configDir: b } }, daemons: {}, routing: { accountB: false } };
      expect(revokeDispatchTrust([cwd], { accountOptions: { map } }).revoked).toEqual([cwd]);
      const after = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'));
      expect(after.projects[cwd]).toBeUndefined();
      expect(after.keep).toBe(1);
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps A and B discoverable, renews both claims and stops both through enable and rollback', () => {
    const dir = mkdtempSync(join(tmpdir(), 'account-lifecycle-'));
    const b = join(dir, 'b');
    mkdirSync(b);
    writeFileSync(join(b, '.claude.json'), '{}');
    const label = 'com.we.fix-dispatch-daemon';
    const env = { HOME: dir, XPC_SERVICE_NAME: label, WE_CLAUDE_AGENTS_CACHE_TTL_MS: '0' };
    const map = { accounts: { b: { configDir: b } }, daemons: { [label]: 'b' }, routing: { accountB: false } };
    const accountOptions = { map };
    const jobs = new Map([[dir, []], [b, []]]);
    const stopped = [];
    const exec = (_cmd, argv, opts) => {
      const profile = opts.env.CLAUDE_CONFIG_DIR || opts.env.HOME;
      const rows = jobs.get(profile);
      if (argv[0] === 'agents') return JSON.stringify(rows);
      if (!rows.some(row => row.sessionId === argv[1])) throw Object.assign(new Error('gone'), { stderr: 'No job matching' });
      stopped.push([profile, argv[1]]);
      jobs.set(profile, rows.filter(row => row.sessionId !== argv[1]));
      return 'stopped';
    };
    // Rows carry the claim's real session name: claim renewal matches the minted name, never the session id.
    const launch = (id, pr) => {
      const selected = markWorkerEnv(env, accountOptions);
      const name = fixDispatchSessionName({ repo: 'we', pr, kind: 'fix' });
      jobs.get(selected.CLAUDE_CONFIG_DIR || selected.HOME).push({ sessionId: id, name, state: 'working' });
    };
    try {
      launch('a', 6832);
      map.routing.accountB = true;
      launch('b', 6833);
      for (const enabled of [true, false]) {
        map.routing.accountB = enabled;
        expect(defaultListAgents({ env, exec, accountOptions }).map(row => row.sessionId).sort()).toEqual(['a', 'b']);
        const lockRoot = join(dir, String(enabled));
        for (const [i, id] of ['a', 'b'].entries()) acquireFixDispatchClaim({ repo: 'we', pr: 6832 + i, owner: id, sessionId: id, lockRoot, nowMs: 1_000 });
        const result = refreshLiveFixDispatchClaims({ lockRoot, nowMs: 541_000, nowIso: () => new Date(541_000).toISOString(),
          listAgentsAll: () => defaultListAgents({ env, exec, accountOptions, all: true }), hungInfoFor: () => null,
          awaitingVerifyFor: () => null, idleRelease: { enabled: false } });
        expect(result.refreshed).toHaveLength(2);
        for (const i of [0, 1]) expect(acquireFixDispatchClaim({ repo: 'we', pr: 6832 + i, owner: 'duplicate', lockRoot, nowMs: 661_000 }).ok).toBe(false);
      }
      stopSession({ handle: 'b', env, exec, accountOptions }); // rollback must still reach B
      map.routing.accountB = true;
      stopSession({ handle: 'a', env, exec, accountOptions }); // enable must still reach A
      expect(stopped).toEqual([[b, 'b'], [dir, 'a']]);
      expect([...jobs.values()].flat()).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
