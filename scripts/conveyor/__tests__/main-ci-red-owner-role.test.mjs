import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { vi.resetModules(); vi.doUnmock('../../operations/dispatch-lane-io.mjs'); vi.doUnmock('../../operations/ci-heal-pr-dispatch.mjs'); delete process.env.WE_GITHUB_APP_ROLE; });

it('withWorkerRole plays worker for the call and restores an inherited observer (or absence) afterwards, even on throw', async () => {
  const { withWorkerRole } = await import('../main-ci-red-io.mjs');
  const env = { WE_GITHUB_APP_ROLE: 'observer' };
  expect(await withWorkerRole(() => env.WE_GITHUB_APP_ROLE, env)).toBe('worker');
  expect(env.WE_GITHUB_APP_ROLE).toBe('observer');
  const bare = {};
  await expect(withWorkerRole(() => { throw Error('boom'); }, bare)).rejects.toThrow('boom');
  expect('WE_GITHUB_APP_ROLE' in bare).toBe(false);
});

it('the main-red owner dispatch reads the worker role in every identity channel (settings env, durable settings, spawn env) while the parent stays observer', async () => {
  process.env.WE_GITHUB_APP_ROLE = 'observer';
  const seen = [];
  const { DISPATCH_EFFECT } = await import('../../operations/dispatch-lane.mjs');
  vi.doMock('../../operations/dispatch-lane-io.mjs', () => ({
    REPO_ROOT: '/root', agentArgsFromEnv: () => [], resolveDispatchSettingsEnv: () => ({}),
    // The real sink resolves settings (and persists them), spawns and wraps from process.env at dispatch time.
    createDispatchSinks: () => ({ [DISPATCH_EFFECT]: async () => { seen.push(process.env.WE_GITHUB_APP_ROLE); return { handle: 'h' }; } }),
  }));
  vi.doMock('../../operations/ci-heal-pr-dispatch.mjs', () => ({ routeAvailableCiHeal: () => null }));
  const { defaultDispatchOwner } = await import('../main-ci-red-io.mjs');
  expect(await defaultDispatchOwner({ prompt: 'p', sessionSlug: 's' })).toEqual({ handle: 'h' });
  expect(seen).toEqual(['worker']);
  expect(process.env.WE_GITHUB_APP_ROLE).toBe('observer');
});
