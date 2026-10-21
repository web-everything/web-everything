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

// Real sink plumbing (createDispatchSinks -> defaultClaudeProvider -> defaultSpawnAgent / launchWrapped) with only the
// OS effects injected. Each assertion reads the identity at its actual delivery boundary, not ambient process.env.
const realPlumbing = async (extra = {}) => {
  const io = await import('../../operations/dispatch-lane-io.mjs');
  const { mkdtempSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const seen = { argvSettings: [], execEnv: [], wrapperEnv: [] };
  const sinkOptions = {
    root: mkdtempSync(join(tmpdir(), 'ci-heal-role-')),
    reserveLane: () => ({ reserved: false }), releaseLane: () => {}, mintSessionId: () => '11111111-1111-4111-8111-111111111111',
    sessionCwdFor: () => '/nonexistent/cwd', ensureSessionCwd: (c) => c, grantLanePermission: () => {}, ensureWorktreeIsolation: () => {},
    // Stands in for the shim's settings resolver, which copies the dispatching process's role into the session settings.
    resolveSettingsEnv: () => ({ WE_GITHUB_APP_ROLE: process.env.WE_GITHUB_APP_ROLE }),
    provider: (request) => io.defaultClaudeProvider(request, {
      spawnAgent: (argv, opts) => io.defaultSpawnAgent(argv, opts, {
        exec: (_cmd, args, options) => {
          const at = args.indexOf('--settings');
          seen.argvSettings.push(JSON.parse(args[at + 1]).env.WE_GITHUB_APP_ROLE);
          seen.execEnv.push(options.env.WE_GITHUB_APP_ROLE);
          return 'backgrounded 11111111-1111-4111-8111-111111111111';
        },
        grantTrust: () => {},
      }),
      wrapKind: () => extra.wrapped === true,
      launchWrapped: (launch) => { seen.wrapperEnv.push(launch.env.WE_GITHUB_APP_ROLE); return { wrapperPid: 1, handle: 'pid:1' }; },
    }),
    ...extra.sinkOptions,
  };
  return { sinkOptions, seen };
};

it('the real dispatch plumbing delivers the worker role in the session settings argv and the spawned process env; the parent stays observer', async () => {
  process.env.WE_GITHUB_APP_ROLE = 'observer';
  const { sinkOptions, seen } = await realPlumbing();
  const { defaultDispatchOwner } = await import('../main-ci-red-io.mjs');
  await defaultDispatchOwner({ prompt: 'p', sessionSlug: 'ci-heal-main' }, sinkOptions);
  expect(seen).toEqual({ argvSettings: ['worker'], execEnv: ['worker'], wrapperEnv: [] });
  expect(process.env.WE_GITHUB_APP_ROLE).toBe('observer');
});

it('the detached worker wrapper is launched with the worker role in its env, and a rejected dispatch still restores observer', async () => {
  process.env.WE_GITHUB_APP_ROLE = 'observer';
  const { sinkOptions, seen } = await realPlumbing({ wrapped: true });
  const { defaultDispatchOwner } = await import('../main-ci-red-io.mjs');
  await defaultDispatchOwner({ prompt: 'p', sessionSlug: 'ci-heal-main' }, sinkOptions);
  expect(seen.wrapperEnv).toEqual(['worker']);
  const failing = await realPlumbing({ sinkOptions: { reserveLane: () => { throw Error('lane down'); } } });
  await expect(defaultDispatchOwner({ prompt: 'p', sessionSlug: 'ci-heal-main' }, failing.sinkOptions)).rejects.toThrow('lane down');
  expect(process.env.WE_GITHUB_APP_ROLE).toBe('observer');
});
