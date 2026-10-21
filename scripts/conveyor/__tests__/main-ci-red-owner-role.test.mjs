import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { vi.resetModules(); vi.doUnmock('../../operations/dispatch-lane-io.mjs'); vi.doUnmock('../../operations/ci-heal-pr-dispatch.mjs'); });

it('workerRoleSettings overrides an inherited observer role and keeps the rest of the settings env', async () => {
  const { workerRoleSettings } = await import('../main-ci-red-io.mjs');
  const env = workerRoleSettings(() => ({ WE_GITHUB_APP_ROLE: 'observer', PATH: '/shim' }))('/cwd');
  expect(env).toEqual({ WE_GITHUB_APP_ROLE: 'worker', PATH: '/shim' });
  expect(workerRoleSettings(() => null)('/cwd')).toEqual({ WE_GITHUB_APP_ROLE: 'worker' });
});

it('the main-red owner dispatch builds its sink so the session settings carry the worker role, not the observer', async () => {
  const createDispatchSinks = vi.fn(() => ({ dispatch: async () => ({ handle: 'h' }) }));
  vi.doMock('../../operations/dispatch-lane-io.mjs', () => ({
    REPO_ROOT: '/root', agentArgsFromEnv: () => [], createDispatchSinks,
    resolveDispatchSettingsEnv: () => ({ WE_GITHUB_APP_ROLE: 'observer' }),
  }));
  vi.doMock('../../operations/ci-heal-pr-dispatch.mjs', () => ({ routeAvailableCiHeal: () => null }));
  const { DISPATCH_EFFECT } = await import('../../operations/dispatch-lane.mjs');
  createDispatchSinks.mockImplementation(() => ({ [DISPATCH_EFFECT]: async () => ({ handle: 'h' }) }));
  const { defaultDispatchOwner } = await import('../main-ci-red-io.mjs');
  expect(await defaultDispatchOwner({ prompt: 'p', sessionSlug: 's' })).toEqual({ handle: 'h' });
  const opts = createDispatchSinks.mock.calls[0][0];
  expect(opts.resolveSettingsEnv('/cwd').WE_GITHUB_APP_ROLE).toBe('worker');
});
