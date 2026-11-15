import { describe, expect, it, vi } from 'vitest';
import { stopSession, STOP_EXEC_OPTS } from '../dispatch-abort.mjs';
import scenario from '../../conveyor/soak/breaks/dispatch-account-session-stop.mjs';
import { sessionProfiles } from '../../lib/claude-sessions.mjs';
import { markWorkerEnv } from '../session-role.mjs';

const LABEL = 'com.we.fix-dispatch-daemon';

describe('profile-scoped session stopping', () => {
  it.each([undefined, '/b', '/b/'])('stops an A worker with B routed but its login missing (inherited profile: %j)', (configDir) => {
    const env = { XPC_SERVICE_NAME: LABEL, ...(configDir ? { CLAUDE_CONFIG_DIR: configDir } : {}) };
    const accountOptions = {
      map: { accounts: { b: { configDir: '/b' } }, daemons: { [LABEL]: 'b' }, routing: { accountB: true } },
      statSync: (path) => {
        if (path === '/b') return { isDirectory: () => true };
        throw Object.assign(new Error('missing login'), { code: 'ENOENT' });
      },
    };
    const exec = vi.fn((_cmd, args, options) => {
      expect(options.env.CLAUDE_CONFIG_DIR).toBeUndefined();
      if (args[0] === 'agents') return '[{"sessionId":"session-a"}]';
      return 'stopped A worker';
    });
    expect(stopSession({ handle: 'session-a', env, exec, accountOptions })).toMatchObject({
      stopped: true, alreadyGone: false, unreadable: ['b'],
    });
    expect(exec).toHaveBeenCalledTimes(2);
    expect(sessionProfiles(env, accountOptions).unreadable).toEqual(['b']);
    const gone = vi.fn(() => { throw Object.assign(new Error('gone'), { stderr: 'No job matching' }); });
    expect(() => stopSession({ handle: 'missing-session', env, exec: gone, accountOptions })).toThrow(/unavailable for account b/);
    expect(gone).toHaveBeenCalledTimes(1);
    expect(() => markWorkerEnv(env, accountOptions)).toThrow(/config directory/);
  });

  it('reclaims B after rollback and A with a broken B caller (real CLI transport)', async () => {
    expect(scenario.judge(await scenario.run({ root: process.cwd() }))).toEqual([]);
  }, 30_000);

  it('retains claims and the B session when its profile becomes invalid after discovery', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(scenario.judge(await scenario.run({ root: process.cwd(), invalidProfile: true }))).toEqual([]);
    } finally { log.mockRestore(); }
  });

  it('checks already-gone in B with sanitized credentials and no worker marker', () => {
    const env = { XPC_SERVICE_NAME: LABEL, CLAUDE_CONFIG_DIR: '/a', ANTHROPIC_API_KEY: 'inherited' };
    const before = { ...env };
    const map = { accounts: { b: { configDir: '/b' } }, daemons: { [LABEL]: 'b' }, routing: { accountB: true } };
    const exec = vi.fn(() => '[]');
    const result = stopSession({ handle: 'session', env, exec, accountOptions: { map,
      statSync: (path) => ({ isDirectory: () => path === '/b', isFile: () => path === '/b/.claude.json', size: 2 }), accessSync: () => {},
    } });
    expect(result).toMatchObject({ stopped: true, alreadyGone: true });
    expect(exec).toHaveBeenCalledWith('claude', ['agents', '--json', '--all'], expect.objectContaining({ env: { XPC_SERVICE_NAME: LABEL, CLAUDE_CONFIG_DIR: '/b' } }));
    expect(exec.mock.calls.every(([, argv]) => argv[0] === 'agents')).toBe(true);
    expect(env).toEqual(before);
  });

  it.each([false, undefined])('preserves the caller environment when routing.accountB=%j', (accountB) => {
    const env = { PATH: '/test-bin', CLAUDE_CONFIG_DIR: '/explicit', XPC_SERVICE_NAME: LABEL };
    const exec = vi.fn((_cmd, args, options) => args[0] === 'agents'
      ? JSON.stringify(options.env.CLAUDE_CONFIG_DIR === '/explicit' ? [{ sessionId: 'session' }] : []) : 'stopped');
    const map = { accounts: { b: { configDir: '/missing' } }, daemons: { [LABEL]: 'b' }, routing: { accountB } };
    expect(stopSession({ handle: 'session', env, exec, accountOptions: { map } }).alreadyGone).toBe(false);
    expect(exec).toHaveBeenCalledWith('claude', ['stop', 'session'], { ...STOP_EXEC_OPTS, env });
  });

  it('refuses malformed routing before attempting stop', () => {
    const exec = vi.fn();
    const map = { accounts: { b: { configDir: '/missing' } }, daemons: { [LABEL]: 'b' }, routing: { accountB: 'true' } };
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => stopSession({ handle: 'session', env: { XPC_SERVICE_NAME: LABEL }, exec,
        accountOptions: { map, statSync: () => { throw new Error('missing profile'); } },
      })).toThrow(/account map unavailable/);
      expect(exec).not.toHaveBeenCalled();
    } finally { log.mockRestore(); }
  });

  it.each(['ENOENT', 'EACCES'])('reports a missing or unreadable routed directory (%s) while stopping A', (code) => {
    const exec = vi.fn((_cmd, args) => args[0] === 'agents' ? '[{"sessionId":"session-a"}]' : 'stopped');
    const accountOptions = {
      map: { accounts: { b: { configDir: '/b' } }, daemons: { [LABEL]: 'b' }, routing: { accountB: true } },
      statSync: () => { throw Object.assign(new Error('unavailable'), { code }); },
    };
    expect(stopSession({ handle: 'session-a', env: { XPC_SERVICE_NAME: LABEL }, exec, accountOptions }))
      .toMatchObject({ stopped: true, alreadyGone: false, unreadable: ['b'] });
    expect(exec).toHaveBeenCalledTimes(2);
    expect(exec.mock.calls[0][2].env.CLAUDE_CONFIG_DIR).toBeUndefined();
  });

  it('a failed caller Keychain read does not block an inherited target profile', () => {
    const env = { XPC_SERVICE_NAME: LABEL, CLAUDE_CONFIG_DIR: '/target', ANTHROPIC_API_KEY: 'stale' };
    const accountOptions = {
      map: { accounts: { a: { service: 'svc', account: 'a' } }, daemons: { [LABEL]: 'a' } },
      readKeychain: () => { throw new Error('unavailable'); },
    };
    const exec = vi.fn((_cmd, args, options) => {
      expect(options.env.ANTHROPIC_API_KEY).toBeUndefined();
      if (args[0] === 'agents') return JSON.stringify(options.env.CLAUDE_CONFIG_DIR === '/target' ? [{ sessionId: 'session-target' }] : []);
      if (options.env.CLAUDE_CONFIG_DIR === '/target') return 'stopped';
      throw Object.assign(new Error('gone'), { stderr: 'No job matching' });
    });
    expect(stopSession({ handle: 'session-target', env, exec, accountOptions }))
      .toMatchObject({ stopped: true, alreadyGone: false, unreadable: ['a'] });
    expect(exec).toHaveBeenCalledTimes(3);
  });

  it('launch enforcement for an unmapped caller cannot block stopping an existing worker', () => {
    const env = { XPC_SERVICE_NAME: LABEL };
    const accountOptions = { map: { accounts: {}, daemons: {}, enforce: true, '*': 'refuse' } };
    const exec = vi.fn((_cmd, args) => args[0] === 'agents' ? '[{"sessionId":"session-a"}]' : 'stopped');
    expect(stopSession({ handle: 'session-a', env, exec, accountOptions }))
      .toMatchObject({ stopped: true, alreadyGone: false, unreadable: [] });
    expect(exec).toHaveBeenCalledWith('claude', ['stop', 'session-a'], { ...STOP_EXEC_OPTS, env });
    expect(() => markWorkerEnv(env, accountOptions)).toThrow(/refused/);
  });
});
