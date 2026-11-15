import { describe, expect, it, vi } from 'vitest';
import { stopSession, STOP_EXEC_OPTS } from '../dispatch-abort.mjs';
import scenario from '../../conveyor/soak/breaks/dispatch-account-session-stop.mjs';

const LABEL = 'com.we.fix-dispatch-daemon';

describe('profile-scoped session stopping', () => {
  it('stops the discovered B fixer before reclaim releases ownership (real CLI transport)', async () => {
    expect(scenario.judge(await scenario.run({ root: process.cwd() }))).toEqual([]);
  });

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
    const exec = vi.fn(() => { throw Object.assign(new Error('gone'), { stderr: 'No job matching session' }); });
    const result = stopSession({ handle: 'session', env, exec, accountOptions: { map,
      statSync: (path) => ({ isDirectory: () => path === '/b', isFile: () => path === '/b/.claude.json', size: 2 }), accessSync: () => {},
    } });
    expect(result).toMatchObject({ stopped: true, alreadyGone: true });
    expect(exec).toHaveBeenCalledWith('claude', ['stop', 'session'], { ...STOP_EXEC_OPTS, env: { XPC_SERVICE_NAME: LABEL, CLAUDE_CONFIG_DIR: '/b' } });
    expect(env).toEqual(before);
  });

  it.each([false, undefined])('preserves the caller environment when routing.accountB=%j', (accountB) => {
    const env = { PATH: '/test-bin', CLAUDE_CONFIG_DIR: '/explicit', XPC_SERVICE_NAME: LABEL };
    const exec = vi.fn(() => 'stopped');
    const map = { accounts: { b: { configDir: '/missing' } }, daemons: { [LABEL]: 'b' }, routing: { accountB } };
    expect(stopSession({ handle: 'session', env, exec, accountOptions: { map } }).alreadyGone).toBe(false);
    expect(exec).toHaveBeenCalledWith('claude', ['stop', 'session'], { ...STOP_EXEC_OPTS, env });
  });

  it.each(['malformed', 'missing-profile'])('refuses %s routing before attempting stop', (variant) => {
    const exec = vi.fn();
    const map = { accounts: { b: { configDir: '/missing' } }, daemons: { [LABEL]: 'b' }, routing: { accountB: variant === 'malformed' ? 'true' : true } };
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => stopSession({ handle: 'session', env: { XPC_SERVICE_NAME: LABEL }, exec,
        accountOptions: { map, statSync: () => { throw new Error('missing profile'); } },
      })).toThrow(/refused|config directory/);
      expect(exec).not.toHaveBeenCalled();
    } finally { log.mockRestore(); }
  });
});
