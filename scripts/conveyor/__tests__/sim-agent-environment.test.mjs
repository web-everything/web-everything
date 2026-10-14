import { execFileSync } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { acquireLane, fail401, postVerdict, releaseLane } from './sim/agent-actions.mjs';

vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal(), execFileSync: vi.fn(),
}));
afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); });

it.each([
  ['verdict CLI', () => postVerdict({ verdict: 'accepted' })],
  ['acquire', () => acquireLane()],
  ['release', () => releaseLane()],
  ['session auth failure', () => fail401()],
])('%s passes only the world environment to its child', (_name, action) => {
  vi.stubEnv('WE_DISPATCH_ROUTING_SNAPSHOT', 'ambient-daemon-snapshot');
  vi.stubEnv('WE_GITHUB_APP_ID', 'ambient-app');
  execFileSync.mockReturnValue('{"lane":1,"path":"/fixture/lane-1"}');
  const env = { PATH: '/fixture/tools', HOME: '/fixture/home', GH_TOKEN: 'world-token' };
  const ctx = {
    simClone: '/fixture/clone', env, repoFor: () => ({ slug: 'fixture/repo' }),
    claude: { killPid: vi.fn(), setState: vi.fn() },
  };
  action().run(ctx, { name: 'review-123', lane: 1, env: { GH_TOKEN: 'session-token' } });
  expect(execFileSync).toHaveBeenCalledOnce();
  const childEnv = execFileSync.mock.calls[0][2].env;
  expect(childEnv).not.toHaveProperty('WE_DISPATCH_ROUTING_SNAPSHOT');
  expect(childEnv).not.toHaveProperty('WE_GITHUB_APP_ID');
  expect(childEnv.PATH).toBe(env.PATH);
  expect(childEnv.GH_TOKEN).toBe(_name === 'session auth failure' ? 'session-token' : 'world-token');
});
