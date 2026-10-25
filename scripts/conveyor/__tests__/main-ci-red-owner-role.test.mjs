/**
 * The ci-heal owner session dispatched from health-watch (the read-only `observer` App role) must play the worker
 * role on every identity channel: the durable `<sessionCwd>/.claude/settings.local.json`, the `--settings` argv, the
 * `claude --bg` spawn env and the detached worker-wrapper env. It gets an explicit env; process.env is never mutated.
 * The real sink plumbing runs (createDispatchSinks -> defaultClaudeProvider -> defaultSpawnAgent / launchWrapped, and
 * the real gh-shim settings writer); only OS effects and this host's App configuration are injected.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROLE = 'WE_GITHUB_APP_ROLE';
let priorRole; let tmp;
beforeEach(() => {
  priorRole = process.env[ROLE]; process.env[ROLE] = 'observer';
  tmp = mkdtempSync(join(tmpdir(), 'ci-heal-role-'));
  mkdirSync(join(tmp, 'bin')); writeFileSync(join(tmp, 'bin', 'gh'), '');
  // This host's App configuration, injected into the REAL settings writer (two roles configured, a real `gh` on PATH).
  vi.doMock('../../lib/gh-app-shim.mjs', async (importOriginal) => {
    const real = await importOriginal();
    return { ...real, buildGhShimSettingsEnv: (o) => real.buildGhShimSettingsEnv({
      ...o, pathEnv: join(tmp, 'bin'), dir: join(tmp, 'shim'), cachePath: join(tmp, 'cache.json'), ghThrottleCliPath: join(tmp, 'gh-throttle.mjs'),
      identity: { anyConfigured: true, roles: { worker: { appId: '1', installations: { o: 1 } }, observer: { appId: '2', installations: { o: 2 } } } },
    }) };
  });
});
afterEach(() => {
  vi.resetModules(); vi.doUnmock('../../lib/gh-app-shim.mjs');
  if (priorRole === undefined) delete process.env[ROLE]; else process.env[ROLE] = priorRole;
});

let sessions = 0;
const plumbing = async ({ wrapped = false, beforeLaunch = async () => {} } = {}) => {
  const io = await import('../../operations/dispatch-lane-io.mjs');
  const seen = { settingsFile: [], argvSettings: [], execEnv: [], wrapperEnv: [] };
  const sinkOptions = {
    root: tmp, reserveLane: () => ({ reserved: false }), releaseLane: () => {},
    mintSessionId: () => `11111111-1111-4111-8111-${String(++sessions).padStart(12, '0')}`,
    sessionCwdFor: (id) => join(tmp, 'sessions', id), ensureSessionCwd: (c) => { mkdirSync(c, { recursive: true }); return c; },
    grantLanePermission: () => {}, ensureWorktreeIsolation: () => {},
    provider: async (request) => {
      await beforeLaunch();
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
  const { defaultDispatchOwner } = await import('../main-ci-red-io.mjs');
  await defaultDispatchOwner({ prompt: 'p', sessionSlug: 'ci-heal-main' }, sinkOptions);
  expect(seen).toEqual({ settingsFile: ['worker'], argvSettings: ['worker'], execEnv: ['worker'], wrapperEnv: [] });
  expect(process.env[ROLE]).toBe('observer');
});

it('launches the detached worker wrapper with the worker role in its env', async () => {
  const { sinkOptions, seen } = await plumbing({ wrapped: true });
  const { defaultDispatchOwner } = await import('../main-ci-red-io.mjs');
  await defaultDispatchOwner({ prompt: 'p', sessionSlug: 'ci-heal-main' }, sinkOptions);
  expect(seen).toEqual({ settingsFile: ['worker'], argvSettings: ['worker'], execEnv: [], wrapperEnv: ['worker'] });
  expect(process.env[ROLE]).toBe('observer');
});

it('two overlapping owner dispatches and an unrelated observer call in between: observer stays observer throughout', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const { io, sinkOptions, seen } = await plumbing({ beforeLaunch: () => gate });
  const { defaultDispatchOwner } = await import('../main-ci-red-io.mjs');
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
  const { DISPATCH_EFFECT } = await import('../../operations/dispatch-lane.mjs');
  await io.createDispatchSinks(sinkOptions)[DISPATCH_EFFECT]({ launchKind: 'ci-heal', prompt: 'p', sessionSlug: 'ci-heal-main', scope: [], repo: 'we' });
  expect(seen).toEqual({ settingsFile: ['observer'], argvSettings: ['observer'], execEnv: ['observer'], wrapperEnv: [] });
});
