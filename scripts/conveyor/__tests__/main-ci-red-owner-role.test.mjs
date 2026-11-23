/**
 * The ci-heal owner session dispatched from health-watch (the read-only `observer` App role) must play the worker
 * role on every identity channel: the durable `<sessionCwd>/.claude/settings.local.json`, the `--settings` argv, the
 * `claude --bg` spawn env and the detached worker-wrapper env. It gets an explicit env; process.env is never mutated.
 * The real sink plumbing runs (createDispatchSinks -> defaultClaudeProvider -> defaultSpawnAgent / launchWrapped, and
 * the real gh-shim settings writer); only OS effects and this host's App configuration are injected.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';

// Repair argv uses the validated committed hook fixture, independent of the operator's HOME.
vi.mock('../../operations/minimal-context-provider.mjs', async (original) => {
  const { withLeanRepairSettingsFixture } = await import('../../operations/__tests__/helpers/lean-repair-settings.mjs');
  return withLeanRepairSettingsFixture(await original());
});
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROLE = 'WE_GITHUB_APP_ROLE';
let priorRole; let tmp;
let io; let defaultDispatchOwner; let DISPATCH_EFFECT;
beforeAll(async () => {
  // This host's App configuration, injected into the REAL settings writer (two roles configured, a real `gh` on PATH).
  vi.doMock('../../lib/gh-app-shim.mjs', async (importOriginal) => {
    const real = await importOriginal();
    return { ...real, buildGhShimSettingsEnv: (o) => real.buildGhShimSettingsEnv({
      ...o, pathEnv: join(tmp, 'bin'), dir: join(tmp, 'shim'), cachePath: join(tmp, 'cache.json'), ghThrottleCliPath: join(tmp, 'gh-throttle.mjs'),
      identity: { anyConfigured: true, roles: { worker: { appId: '1', installations: { o: 1 } }, observer: { appId: '2', installations: { o: 2 } } } },
    }) };
  });
  // Load the real dispatch graph once, outside the 5s behavioral test budget. The owner also lazily imports
  // ci-heal routing; warm that here too. The shim callback reads each test's current tmp directory at call time.
  io = await import('../../operations/dispatch-lane-io.mjs');
  ({ defaultDispatchOwner } = await import('../main-ci-red-io.mjs'));
  ({ DISPATCH_EFFECT } = await import('../../operations/dispatch-lane.mjs'));
  await import('../../operations/ci-heal-pr-dispatch.mjs');
  await import('../reconcile-fix-dispatch.mjs');
}, 30_000);
afterAll(() => { vi.doUnmock('../../lib/gh-app-shim.mjs'); });
beforeEach(() => {
  priorRole = process.env[ROLE]; process.env[ROLE] = 'observer';
  tmp = mkdtempSync(join(tmpdir(), 'ci-heal-role-'));
  vi.stubEnv('LANE_POOL_ROOT', join(tmp, 'lane-pool'));
  mkdirSync(join(tmp, 'bin')); writeFileSync(join(tmp, 'bin', 'gh'), '');
});
afterEach(() => {
  vi.unstubAllEnvs();
  if (priorRole === undefined) delete process.env[ROLE]; else process.env[ROLE] = priorRole;
  rmSync(tmp, { recursive: true, force: true });
});

let sessions = 0;
const plumbing = async ({ wrapped = false, beforeLaunch = async () => {} } = {}) => {
  const seen = { settingsFile: [], argvSettings: [], execEnv: [], wrapperEnv: [] };
  const sinkOptions = {
    pickFreeLanes: () => [7],
    root: tmp, reserveLane: () => ({ reserved: false }), releaseLane: () => {},
    mintSessionId: () => `11111111-1111-4111-8111-${String(++sessions).padStart(12, '0')}`,
    sessionCwdFor: (id) => join(tmp, 'sessions', id), ensureSessionCwd: (c) => { mkdirSync(c, { recursive: true }); return c; },
    grantLanePermission: () => {}, ensureWorktreeIsolation: () => {},
    provider: async (request) => {
      await beforeLaunch();
      expect(request.lane).toBe(7);
      expect(request.dispatchRoot).toBe(tmp);
      seen.settingsFile.push(JSON.parse(readFileSync(join(request.cwd, '.claude', 'settings.local.json'), 'utf8')).env[ROLE]);
      return io.defaultClaudeProvider(request, {
        spawnAgent: (argv, opts) => io.defaultSpawnAgent(argv, opts, {
          exec: (_cmd, args, options) => {
            seen.argvSettings.push(JSON.parse(args[args.indexOf('--settings') + 1]).env[ROLE]);
            seen.execEnv.push(options.env[ROLE]);
            return 'backgrounded 11111111-1111-4111-8111-111111111111';
          },
          grantTrust: () => {},
        }),
        wrapKind: () => wrapped,
        launchWrapped: (launch) => {
          seen.argvSettings.push(JSON.parse(launch.bgArgv[launch.bgArgv.indexOf('--settings') + 1]).env[ROLE]);
          seen.wrapperEnv.push(launch.env[ROLE]); return { wrapperPid: 1, handle: 'pid:1' };
        },
      });
    },
  };
  return { io, sinkOptions, seen };
};

it('delivers the worker role in the real settings.local.json, the --settings argv and the spawn env; the parent stays observer', async () => {
  const { sinkOptions, seen } = await plumbing();
  await defaultDispatchOwner({ prompt: 'p', sessionSlug: 'ci-heal-main' }, sinkOptions);
  expect(seen).toEqual({ settingsFile: ['worker'], argvSettings: ['worker'], execEnv: ['worker'], wrapperEnv: [] });
  expect(process.env[ROLE]).toBe('observer');
});

it('launches the detached worker wrapper with the worker role in its env', async () => {
  const { sinkOptions, seen } = await plumbing({ wrapped: true });
  await defaultDispatchOwner({ prompt: 'p', sessionSlug: 'ci-heal-main' }, sinkOptions);
  expect(seen).toEqual({ settingsFile: ['worker'], argvSettings: ['worker'], execEnv: [], wrapperEnv: ['worker'] });
  expect(process.env[ROLE]).toBe('observer');
});

it('two overlapping owner dispatches and an unrelated observer call in between: observer stays observer throughout', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const { io, sinkOptions, seen } = await plumbing({ beforeLaunch: () => gate });
  const first = defaultDispatchOwner({ prompt: 'p', sessionSlug: 'ci-heal-main' }, sinkOptions);
  const second = defaultDispatchOwner({ prompt: 'p', sessionSlug: 'ci-heal-main' }, sinkOptions);
  await new Promise((r) => setTimeout(r, 0));
  // Unrelated health-watch work while both dispatches are in flight still reads (and hands on) the observer role.
  expect(process.env[ROLE]).toBe('observer');
  expect(io.workerSpawnEnv()[ROLE]).toBe('observer');
  release(); await Promise.all([first, second]);
  expect(seen.settingsFile).toEqual(['worker', 'worker']);
  expect(seen.execEnv).toEqual(['worker', 'worker']);
  expect(process.env[ROLE]).toBe('observer');
});

it('a dispatch that passes no spawnEnv keeps the dispatcher role on every channel (other kinds unchanged)', async () => {
  const { io, sinkOptions, seen } = await plumbing();
  await io.createDispatchSinks(sinkOptions)[DISPATCH_EFFECT]({ launchKind: 'ci-heal', prompt: 'p', sessionSlug: 'ci-heal-main', lane: 7, scope: [], repo: 'we' });
  expect(seen).toEqual({ settingsFile: ['observer'], argvSettings: ['observer'], execEnv: ['observer'], wrapperEnv: [] });
});

it('binds the owner brief and launch grant to the selected lane', async () => {
  const { sinkOptions, seen } = await plumbing({ beforeLaunch: () => {} });
  const provider = sinkOptions.provider;
  sinkOptions.provider = request => {
    expect(request.prompt).toContain('--lane=7 --session=ci-heal-main');
    expect(request.laneGrant.additionalDirectories).toEqual([join(tmp, 'lane-pool/web-everything/lane-7')]);
    return provider(request);
  };
  await defaultDispatchOwner({ prompt: 'p', sessionSlug: 'ci-heal-main' }, sinkOptions);
  expect(seen.execEnv).toEqual(['worker']);
});

it.each([[], [null], [0], ['7'], [Number.MAX_SAFE_INTEGER + 1]].map(lanes => ({ lanes })))(
  'holds without spawning when no valid named lane is available: $lanes', async ({ lanes }) => {
    const { sinkOptions, seen } = await plumbing();
    expect(await defaultDispatchOwner({ prompt: 'p', sessionSlug: 'ci-heal-main' }, {
      ...sinkOptions, pickFreeLanes: () => lanes,
    })).toEqual({ held: true, reason: 'no named lane available; free a lane and retry' });
    expect(seen).toEqual({ settingsFile: [], argvSettings: [], execEnv: [], wrapperEnv: [] });
  },
);

it('holds without spawning when the lane availability read fails', async () => {
  const { sinkOptions, seen } = await plumbing();
  expect(await defaultDispatchOwner({ prompt: 'p', sessionSlug: 'ci-heal-main' }, {
    ...sinkOptions, pickFreeLanes: () => { throw new Error('pool unreadable'); },
  })).toEqual({ held: true, reason: 'lane availability unknown; inspect the lane pool and retry' });
  expect(seen).toEqual({ settingsFile: [], argvSettings: [], execEnv: [], wrapperEnv: [] });
});

it.each([undefined, '', '   ', '--hostile'])('holds an invalid owner brief before adding lane instructions: %j', async prompt => {
  const { sinkOptions, seen } = await plumbing();
  const pickFreeLanes = vi.fn(() => [7]);
  expect(await defaultDispatchOwner({ prompt, sessionSlug: 'ci-heal-main' }, { ...sinkOptions, pickFreeLanes }))
    .toEqual({ held: true, reason: 'invalid owner brief; restore a nonempty, non-flag brief before retrying' });
  expect(pickFreeLanes).not.toHaveBeenCalled();
  expect(seen).toEqual({ settingsFile: [], argvSettings: [], execEnv: [], wrapperEnv: [] });
});
