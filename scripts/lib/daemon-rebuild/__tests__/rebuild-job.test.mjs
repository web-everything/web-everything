/** Rebuild herd spacing: stable identity, bounded additive jitter, and historical settings. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import nodeFs, { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRebuildAsJobSettings, rebuildJobInterval, rebuildCloneAsJob, REBUILD_JOB_KIND } from '../rebuild-job.mjs';
import { createJobStore, enqueueJob } from '../../daemon-jobs-runtime.mjs';
import { writeReadyCandidate, readReadyCandidate, writeRebuildState, readRebuildState, readRebuildStateStrict, rebuildStatePath, readyCandidatePath, readReadyCandidateStrict } from '../state.mjs';
import { pendingAdoptionPath, readPendingAdoptionsStrict } from '../../overlay-adoption.mjs';
import { markSucceeded } from '../../daemon-jobs.mjs';
import { rebuildClone } from '../rebuild.mjs';
import * as planner from '../plan.mjs';
import * as edgeFetch from '../edge-fetch.mjs';
import * as laneRepair from '../../lane-repair.mjs';
import * as rebuildJob from '../rebuild-job.mjs';
import * as forceAdopt from '../../daemon-force-adopt.mjs';
import * as overlayAdoption from '../../overlay-adoption.mjs';
import * as preparation from '../prepare.mjs';
import * as stateIO from '../state.mjs';
import { matchReadyCandidate } from '../adopt.mjs';

let root;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'we-job-jitter-')); });
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

it.each([[undefined, 20], [0, 0], [-5, 0], [120, 100], ['bad', 20]])(
  'settings reader defaults or clamps jitter %s to %s without dropping historical entries', (input, expected) => {
    const path = join(root, 'settings.json');
    writeFileSync(path, JSON.stringify({ rebuildAsJob: { entries: ['review-daemon.mjs'], minIntervalMs: 300,
      ...(input === undefined ? {} : { minIntervalJitterPct: input }),
    } }));
    const settings = loadRebuildAsJobSettings(path, { env: {} });
    expect(settings).toEqual({ entries: ['review-daemon.mjs'], minIntervalMs: 300, minIntervalJitterPct: expected });
  },
);

it('unreadable settings keep the safe jitter default and job mode disabled', () => {
  expect(loadRebuildAsJobSettings(join(root, 'missing.json'), { env: {} })).toEqual({
    entries: [], minIntervalMs: 300000, minIntervalJitterPct: 20,
  });
});

it.each([[-1, 100], [0, 100], [0.5, 110], [1, 120], [9, 120], [NaN, 120]])(
  'bounds injected fraction %s to an interval of %s, never below the configured minimum', (fraction, expected) => {
    expect(rebuildJobInterval({ minIntervalMs: 100, minIntervalJitterPct: 20 }, ['review-daemon.mjs'], () => fraction)).toBeCloseTo(expected, 10);
  },
);

it('zero percent disables jitter and oversized percentages are capped at 100', () => {
  const rng = vi.fn(() => 1);
  expect(rebuildJobInterval({ minIntervalMs: 100, minIntervalJitterPct: 0 }, [], rng)).toBe(100);
  expect(rng).not.toHaveBeenCalled();
  expect(rebuildJobInterval({ minIntervalMs: 100, minIntervalJitterPct: 1000 }, [], () => 1)).toBe(200);
});

it('logs the effective clamped jitter and its tool provenance', () => {
  const path = join(root, 'settings.json');
  const log = vi.fn();
  writeFileSync(path, JSON.stringify({ rebuildAsJob: { minIntervalJitterPct: 900 } }));
  expect(loadRebuildAsJobSettings(path, { env: {}, log }).minIntervalJitterPct).toBe(100);
  expect(log).toHaveBeenCalledWith('daemon-rebuild-job: minIntervalJitterPct=100 (tool; clamped to 0-100)');
});

it('default jitter is stable by daemon basename across restarts and paths, and spreads distinct entries', () => {
  const settings = { minIntervalMs: 300000, minIntervalJitterPct: 20 };
  const first = rebuildJobInterval(settings, ['scripts/review-daemon.mjs']);
  expect(rebuildJobInterval(settings, ['other/review-daemon.mjs'])).toBe(first);
  expect(first).toBeGreaterThanOrEqual(300000);
  expect(first).toBeLessThanOrEqual(360000);
  expect(rebuildJobInterval(settings, ['scripts/pass-daemon.mjs'])).not.toBe(first);
});

it.each([[20, 1100, 'rebuild-job-spaced', 100], [0, 1100, 'rebuild-job-started', undefined],
  [20, 1200, 'rebuild-job-started', undefined]])(
  'tick enforces jitter=%s at elapsed=%s including disable and exact due boundary', async (pct, elapsed, reason, retry) => {
    mkdirSync(join(root, 'jobs'));
    const store = createJobStore(join(root, 'jobs'));
    const started = 1700000000000;
    const rec = enqueueJob({ store, kindDef: REBUILD_JOB_KIND, codeSha: 'a'.repeat(40), input: { root }, now: started - 1000 });
    store.update(rec.id, r => markSucceeded(r, { at: new Date(started).toISOString() }));
    const result = await rebuildCloneAsJob({
      root, env: {}, store, entries: ['scripts/review-daemon.mjs'],
      adopt: async () => ({ reason: 'needs-build', plan: { finalSha: 'b'.repeat(40) } }),
      reattach: async () => ({}), evict: () => ({}), log: { error() {} }, codeSha: 'a'.repeat(40),
      now: () => started + elapsed, rng: () => 1,
      settings: { entries: [], minIntervalMs: 1000, minIntervalJitterPct: pct },
    });
    expect(result.reason).toBe(reason);
    if (retry !== undefined) expect(result.retryInMs).toBe(retry);
    expect(store.list().records).toHaveLength(reason === 'rebuild-job-spaced' ? 1 : 2);
  },
);

it.each(['before-reattach', 'during-reattach'])('never starts or restarts a job with ready evidence %s', async phase => {
  const env = { WE_DAEMON_STATE_DIR: join(root, 'state') };
  mkdirSync(join(root, 'jobs'));
  const store = createJobStore(join(root, 'jobs'));
  const old = enqueueJob({ store, kindDef: REBUILD_JOB_KIND, codeSha: 'a'.repeat(40), input: { root } });
  const ready = { kind: 'candidate', prevHead: 'old', tree: 'tree', passedAt: new Date().toISOString(),
    adopt: { finalSha: 'ready', inputsKey: 'inputs', mainSha: 'main', applied: [] } };
  const publish = () => writeReadyCandidate(root, ready, env);
  if (phase === 'before-reattach') publish();
  const reattach = vi.fn(async () => {
    publish();
    store.update(old.id, r => markSucceeded(r, { at: new Date().toISOString() }));
  });
  const adopt = vi.fn(async () => ({ reason: 'needs-build' }));
  const result = await rebuildCloneAsJob({ root, env, store, adopt, reattach, codeSha: 'a'.repeat(40),
    log: { error() {} }, evict: () => ({}) });
  expect(result.reason).toBe('ready-pending');
  expect(readReadyCandidate(root, env)?.adopt.finalSha).toBe('ready');
  expect(store.list().records).toHaveLength(1);
  expect(reattach).toHaveBeenCalledTimes(1); // a non-adopting ready record must not suppress job recovery
  expect(adopt).toHaveBeenCalledTimes(1);
});

it.each([true, false])('launchOnly=%s refuses unreadable state and permits only clean absence for early/recovery jobs', async launchOnly => {
  const env = { WE_DAEMON_STATE_DIR: join(root, 'state') };
  const file = rebuildStatePath(root, env);
  for (const failure of ['EACCES', 'EIO', 'corrupt', 'null', 'array', 'ENOENT']) {
    writeRebuildState(root, { held: { reason: 'smoke-env-timeout', retryAt: new Date(9_000_000).toISOString() },
      rejected: { inputsKey: 'unchanged' } }, env);
    if (failure === 'corrupt') writeFileSync(file, '{broken');
    if (failure === 'null') writeFileSync(file, 'null');
    if (failure === 'array') writeFileSync(file, '[]');
    if (failure === 'ENOENT') rmSync(file);
    const read = (path, ...args) => {
      if (path === file && ['EACCES', 'EIO'].includes(failure)) throw Object.assign(new Error(failure), { code: failure });
      return readFileSync(path, ...args);
    };
    const readState = (root, env) => readRebuildStateStrict(root, env, read);
    const store = createJobStore(join(root, `jobs-${failure}`));
    const adopt = vi.fn(async () => ({ reason: launchOnly ? 'needs-build' : 'up-to-date' }));
    const reattach = vi.fn(async () => ({}));
    const result = await rebuildCloneAsJob({ root, env, store, adopt, reattach, launchOnly, readState,
      readPending: () => [{ at: new Date(0).toISOString() }], now: () => 2_000_000,
      recoverySettings: { envTimeoutBaseMs: 1000, envTimeoutMaxMs: 4000, overlayOverdueMs: 900000 },
      codeSha: 'a'.repeat(40), settings: { minIntervalMs: 0, minIntervalJitterPct: 0 },
      log: { error() {} }, evict: () => ({}) });
    const absent = failure === 'ENOENT';
    expect(result.reason, failure).toBe(absent ? 'rebuild-job-started' : 'state-unreadable');
    expect(store.list().records, failure).toHaveLength(absent ? 1 : 0);
    expect(reattach, failure).toHaveBeenCalledTimes(absent ? 1 : 0);
    expect(adopt, failure).toHaveBeenCalledTimes(absent ? 1 : 0);
    // Legacy consumers still receive empty state on every read/parse failure.
    if (!['EACCES', 'EIO'].includes(failure)) expect(readRebuildState(root, env)).toMatchObject({ held: null, rejected: null });
    if (absent) expect(readRebuildStateStrict(root, env)).toEqual(readRebuildState(root, env));
    else expect(() => readState(root, env)).toThrow();
  }
});

it.each([
  ['sticky rejection', { rejected: { inputsKey: 'unchanged', reason: 'failed', at: new Date(0).toISOString() } }, 'still-rejected'],
  ['smoke backoff', { held: { reason: 'smoke-harness-broken', since: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), retryAt: null, attempts: 1 },
    rejected: { inputsKey: 'older', reason: 'failed', at: new Date(0).toISOString(), harnessBroken: true, retryAt: new Date(2000).toISOString() } }, 'smoke-harness-broken-backoff'],
  ['retry not yet due', { rejected: { inputsKey: 'unchanged', reason: 'failed', at: new Date(0).toISOString(), retryAt: new Date(2000).toISOString() } }, 'still-rejected'],
  ['clean state', {}, 'rebuild-job-started'],
  ...[true, false].flatMap(launchOnly => ['corrupt', 'EACCES'].map(failure =>
    [failure, { rejected: { inputsKey: 'unchanged' } }, 'state-unreadable', launchOnly, failure])),
])('%s applies real preparation admission before queuing', async (_name, state, reason, launchOnly = true, failure) => {
  const env = { WE_DAEMON_STATE_DIR: join(root, 'state'), WE_DAEMON_OVERLAY_DIR: join(root, 'overlays'),
    WE_DAEMON_CLONE_LOCK_ROOT: join(root, 'locks'), WE_DAEMON_AUTO_REBASE: '0' };
  const plan = { ok: true, upToDate: false, finalSha: 'b'.repeat(40), mainSha: 'b'.repeat(40),
    inputsKey: 'unchanged', applied: [], decisions: [], alerts: [] };
  writeRebuildState(root, state, env);
  const file = rebuildStatePath(root, env);
  if (failure === 'corrupt') writeFileSync(file, '{broken');
  const original = readFileSync(file, 'utf8');
  // Inject the OS read error rather than chmod: privileged runners can read mode-000 files.
  const readState = (root, env) => readRebuildStateStrict(root, env, (path, ...args) => {
    if (path === file && failure === 'EACCES') throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    return readFileSync(path, ...args);
  });
  // Keep the real prepare/decision path; only Git and clone diagnosis are fixture IO.
  vi.spyOn(planner, 'planRebuild').mockResolvedValue(plan);
  vi.spyOn(edgeFetch, 'fetchMainAndOverlays').mockReturnValue({ ok: true, goneRefs: [] });
  vi.spyOn(laneRepair, 'probeBrokenRefs').mockReturnValue({ probeFailed: false, broken: [] });
  vi.spyOn(laneRepair, 'diagnoseLane').mockReturnValue({ ok: true, problems: [] });
  const run = vi.fn(args => {
    if (args[0] === 'symbolic-ref') return { status: 0, stdout: 'main' };
    if (args[0] === 'rev-parse') return args.includes('MERGE_HEAD')
      ? { status: 1, stdout: '' } : { status: 0, stdout: 'a'.repeat(40) };
    if (['commit-graph', 'ls-files', 'status', 'rev-list'].includes(args[0])) return { status: 0, stdout: '' };
    throw new Error(`unexpected git: ${args.join(' ')}`);
  });
  const runSmoke = vi.fn(() => { throw new Error('unexpected smoke'); });
  const adopt = vi.fn(options => rebuildClone({ root, env, run, runSmoke, versions: null,
    now: () => 1000, log: { error() {} }, lockOpts: { waitMs: 0 },
    ...options, adoptOnly: true, asJob: false }));
  const store = createJobStore(join(root, 'jobs'));
  const reattach = vi.fn(async () => ({}));
  const result = await rebuildCloneAsJob({ root, env, store, adopt, reattach, launchOnly, readState,
    codeSha: 'a'.repeat(40), now: () => 1000, log: { error() {} }, evict: () => ({}),
    settings: { minIntervalMs: 0, minIntervalJitterPct: 0 } });
  expect(result.reason).toBe(reason);
  expect(adopt).toHaveBeenCalledTimes(failure ? 0 : 1);
  if (failure) expect(readFileSync(file, 'utf8')).toBe(original);
  else expect(adopt).toHaveBeenCalledWith({ readyOnly: true, admissionEvidence: { state: expect.any(Object), ready: null } });
  expect(store.list().records).toHaveLength(reason === 'rebuild-job-started' ? 1 : 0);
  expect(reattach).toHaveBeenCalledTimes(reason === 'rebuild-job-started' ? 1 : 0);
  expect(runSmoke).not.toHaveBeenCalled();
});


it.each([
  ['held missing reason', { held: {} }],
  ['held wrong type', { held: 'smoke-env-timeout' }],
  ['held missing persisted date', { held: { reason: 'smoke-harness-broken' } }],
  ['held missing deadline origin', { held: { reason: 'smoke-env-timeout' } }],
  ['held invalid retryAt', { held: { reason: 'smoke-env-timeout', retryAt: 42 } }],
  ['held invalid attempts', { held: { reason: 'smoke-env-timeout', retryAt: new Date(0).toISOString(), attempts: '1' } }],
  ['rejected missing identity', { rejected: {} }],
  ['rejected wrong type', { rejected: [] }],
  ['rejected invalid retryAt', { rejected: { inputsKey: 'key', retryAt: 'bad' } }],
  ['rejected missing backoff', { rejected: { inputsKey: 'key', harnessBroken: true } }],
  ...['adopted', 'inProgress', 'quarantine', 'unverified', 'building'].map(key => [`${key} incomplete`, { [key]: {} }]),
  ...['busySkippedTrees', 'forceUnverifiedTrees'].map(key => [`${key} invalid member`, { [key]: [42] }]),
  ['smokePassed incomplete', { smokePassed: [{}] }],
  ['pinnedNotified invalid member', { pinnedNotified: { ref: 42 } }],
])('%s refuses launchOnly before any mutation or reattach', async (_name, state) => {
  const env = { WE_DAEMON_STATE_DIR: join(root, 'state') };
  writeRebuildState(root, state, env);
  const file = rebuildStatePath(root, env);
  const original = readFileSync(file, 'utf8');
  const store = createJobStore(join(root, 'jobs'));
  const adopt = vi.fn(); const reattach = vi.fn(); const error = vi.fn();
  const result = await rebuildCloneAsJob({ root, env, store, adopt, reattach, launchOnly: true, log: { error } });
  expect(result.reason).toBe('state-unreadable');
  expect(adopt).not.toHaveBeenCalled(); expect(reattach).not.toHaveBeenCalled();
  expect(readFileSync(file, 'utf8')).toBe(original);
  expect(nodeFs.existsSync(store.dir)).toBe(false);
  expect(error).toHaveBeenCalledWith(expect.stringContaining('repair persisted evidence'));
});

it.each(['corrupt', 'null', 'missing adopt', 'wrong finalSha', 'EACCES', 'ENOENT'])(
  'ready evidence %s fails closed; only absence permits launch', async failure => {
    const env = { WE_DAEMON_STATE_DIR: join(root, 'state') };
    mkdirSync(env.WE_DAEMON_STATE_DIR);
    const file = readyCandidatePath(root, env);
    const text = failure === 'corrupt' ? '{broken' : JSON.stringify(failure === 'null' ? null
      : failure === 'missing adopt' ? { prevHead: 'head' } : { prevHead: 'head', adopt: { finalSha: 42 } });
    if (failure !== 'ENOENT') writeFileSync(file, text);
    const readReady = (root, env) => readReadyCandidateStrict(root, env, (path, ...args) => {
      if (failure === 'EACCES') throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return readFileSync(path, ...args);
    });
    const store = createJobStore(join(root, 'jobs'));
    const adopt = vi.fn(async () => ({ reason: 'needs-build' })); const reattach = vi.fn();
    const result = await rebuildCloneAsJob({ root, env, store, adopt, reattach, readReady, launchOnly: true,
      codeSha: 'a'.repeat(40), evict() {}, log: { error() {} } });
    const absent = failure === 'ENOENT';
    expect(result.reason).toBe(absent ? 'rebuild-job-started' : 'state-unreadable');
    expect(reattach).toHaveBeenCalledTimes(absent ? 1 : 0);
    expect(adopt).toHaveBeenCalledTimes(absent ? 1 : 0);
    if (!absent) { expect(readFileSync(file, 'utf8')).toBe(text); expect(nodeFs.existsSync(store.dir)).toBe(false); }
  });

it.each([
  ['forced string', { forced: 'true' }], ['forced number', { forced: 1 }], ['forced null', { forced: null }],
  ['kind', { kind: false }], ['at', { at: 42 }], ['passedAt', { passedAt: false }],
  ['tree', { tree: [] }], ['prevHead', { prevHead: 42 }], ['forInputsKey', { forInputsKey: false }],
  ['dropRefs array', { dropRefs: {} }], ['dropRefs record', { dropRefs: [null] }],
  ['dropRefs ref', { dropRefs: [{ ref: 42 }] }], ['dropRefs sha', { dropRefs: [{ ref: 'lane/x', sha: false }] }],
  ['dropRefs pr', { dropRefs: [{ ref: 'lane/x', pr: '123' }] }],
  ['failed', { failed: [] }], ['token', { token: false }], ['pid', { pid: '1' }], ['host', { host: 42 }],
  ['adopt finalSha', { adopt: { finalSha: 42 } }],
  ['adopt inputsKey', { adopt: { finalSha: 'target', inputsKey: false } }],
  ['adopt mainSha', { adopt: { finalSha: 'target', mainSha: [] } }],
  ['adopt applied', { adopt: { finalSha: 'target', applied: [{ ref: 'lane/x', sha: false }] } }],
  ['adopt pinnedFrom', { adopt: { applied: [{ ref: 'lane/x', sha: 'tip', pinnedFrom: true }] } }],
])('wrong ready %s type refuses before adoption or job mutation, preserving evidence', async (_name, patch) => {
  const env = { WE_DAEMON_STATE_DIR: join(root, 'state') };
  writeReadyCandidate(root, { ...completeReady(), kind: 'candidate', ...patch,
    adopt: patch.adopt ? { ...completeReady().adopt, ...patch.adopt } : completeReady().adopt }, env);
  const file = readyCandidatePath(root, env);
  const original = readFileSync(file, 'utf8');
  const adopt = vi.fn(); const reattach = vi.fn(); const error = vi.fn();
  const store = createJobStore(join(root, 'jobs'));
  const result = await rebuildCloneAsJob({ root, env, store, adopt, reattach, log: { error } });
  expect(result.reason).toBe('state-unreadable');
  expect(adopt).not.toHaveBeenCalled(); expect(reattach).not.toHaveBeenCalled();
  expect(readFileSync(file, 'utf8')).toBe(original);
  expect(nodeFs.existsSync(store.dir)).toBe(false);
  expect(error).toHaveBeenCalledWith(expect.stringContaining('repair persisted evidence'));
});

it.each([{}, { forced: false }, { forced: true }, {
  kind: 'fallback', forInputsKey: 'inputs', dropRefs: [{ ref: 'lane/x', sha: 'tip', pr: 123 }, { ref: 'lane/y', sha: 'tip', pr: null }],
  failed: '', at: new Date(0).toISOString(), tree: 'tree', token: 'lease', pid: 1, host: 'host',
  adopt: { finalSha: 'target', inputsKey: 'inputs', mainSha: 'main', applied: [{ ref: 'lane/z', sha: 'tip' }] },
}])('strict ready reader preserves valid optional and historical fields %j', patch => {
  const env = { WE_DAEMON_STATE_DIR: join(root, 'state') };
  const ready = { kind: 'candidate', forced: false, tree: 'tree', prevHead: 'head', adopt: { finalSha: 'target', inputsKey: 'inputs', mainSha: 'main', applied: [] }, passedAt: new Date(0).toISOString(), ...patch };
  writeReadyCandidate(root, ready, env);
  expect(readReadyCandidateStrict(root, env)).toEqual(ready);
});

it.each([true, false].flatMap(launchOnly => ['rebuild', 'ready'].map(kind => [launchOnly, kind])))(
  'launchOnly=%s refuses corrupt %s evidence in stateOpts.env override before preparation', async (launchOnly, kind) => {
    const env = { WE_DAEMON_STATE_DIR: join(root, 'base-state'), WE_DAEMON_OVERLAY_DIR: join(root, 'overlays') };
    const stateOpts = { env: { WE_DAEMON_STATE_DIR: join(root, 'override-state') } };
    writeRebuildState(root, {}, env);
    mkdirSync(stateOpts.env.WE_DAEMON_STATE_DIR);
    const file = (kind === 'rebuild' ? rebuildStatePath : readyCandidatePath)(root, stateOpts.env);
    writeFileSync(file, '{broken');
    const prepare = vi.spyOn(preparation, 'prepareRebuild');
    const run = vi.fn(); const runSmoke = vi.fn(); const error = vi.fn();
    const result = await rebuildClone({ root, env, stateOpts, asJob: true, launchOnly, run, runSmoke,
      log: { error }, emitEvent: vi.fn() });
    expect(result.reason).toBe('state-unreadable');
    expect(prepare).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled(); expect(runSmoke).not.toHaveBeenCalled();
    expect(readFileSync(file, 'utf8')).toBe('{broken');
    expect(error).toHaveBeenCalledWith(expect.stringContaining('repair persisted evidence'));
  });

it('job admission and preparation share the same merged state environment', async () => {
  const env = { WE_DAEMON_STATE_DIR: join(root, 'base-state'), WE_DAEMON_CLONE_LOCK_ROOT: join(root, 'locks') };
  const stateOpts = { env: { WE_DAEMON_STATE_DIR: join(root, 'override-state') } };
  const prepare = vi.spyOn(preparation, 'prepareRebuild').mockResolvedValue({
    terminal: true, result: { moved: false, reason: 'up-to-date' },
  });
  let admittedEnv;
  vi.spyOn(rebuildJob, 'rebuildCloneAsJob').mockImplementation(async ({ env, adopt }) => {
    admittedEnv = env;
    return adopt();
  });
  await rebuildClone({ root, env, stateOpts, asJob: true, versions: null, log: { error() {} }, emitEvent: vi.fn() });
  expect(admittedEnv).toEqual({ ...env, ...stateOpts.env });
  expect(prepare).toHaveBeenCalledOnce();
  expect(prepare.mock.calls[0][0].stEnv).toBe(admittedEnv);
});

it.each([true, false].flatMap(launchOnly =>
  ['corrupt', 'object', 'invalid record', 'missing at', 'invalid at', 'invalid overdueSent', 'EACCES', 'ENOENT']
    .map(failure => [launchOnly, failure])))(
  'launchOnly=%s pending-adoptions %s refuses before preparation, preserves files and logs; absence is empty', async (launchOnly, failure) => {
    const env = { WE_DAEMON_STATE_DIR: join(root, 'state'), WE_DAEMON_OVERLAY_DIR: join(root, 'overlays') };
    const file = pendingAdoptionPath(root, env);
    mkdirSync(join(env.WE_DAEMON_OVERLAY_DIR, 'adoption-pending'), { recursive: true });
    const rec = { ref: 'lane/x', sha: 'a'.repeat(40), at: new Date(0).toISOString() };
    const text = failure === 'corrupt' ? '{broken' : JSON.stringify(failure === 'object' ? {}
      : failure === 'invalid record' ? [rec, {}] : failure === 'missing at' ? [{ ref: rec.ref, sha: rec.sha }]
      : failure === 'invalid at' ? [{ ...rec, at: false }]
      : failure === 'invalid overdueSent' ? [{ ...rec, overdueSent: 'yes' }] : [rec]);
    if (failure !== 'ENOENT') writeFileSync(file, text);
    const readPending = (root, options) => readPendingAdoptionsStrict(root, { ...options, fs: { ...nodeFs,
      readFileSync(path, ...args) {
        if (failure === 'EACCES') throw Object.assign(new Error('denied'), { code: 'EACCES' });
        return readFileSync(path, ...args);
      } } });
    const adopt = vi.fn(async () => ({ reason: 'needs-build' })); const reattach = vi.fn(); const error = vi.fn();
    const store = createJobStore(join(root, 'jobs'));
    const result = await rebuildCloneAsJob({ root, env, store, adopt, reattach, readPending, launchOnly,
      codeSha: 'a'.repeat(40), evict() {}, log: { error } });
    const absent = failure === 'ENOENT';
    expect(result.reason).toBe(absent ? 'rebuild-job-started' : 'state-unreadable');
    expect(reattach).toHaveBeenCalledTimes(absent ? 1 : 0); expect(adopt).toHaveBeenCalledTimes(absent ? 1 : 0);
    if (!absent) {
      expect(readFileSync(file, 'utf8')).toBe(text); expect(nodeFs.existsSync(store.dir)).toBe(false);
      expect(error).toHaveBeenCalledWith(expect.stringContaining('pending-adoptions'));
    } else expect(readPendingAdoptionsStrict(root, { env })).toEqual([]);
  });

it.each([['early', true], ['recovery', true], ['tick-start', true], ['tick-start', false]])(
  '%s launchOnly=%s preserves mixed overdue and malformed pending-adoption bytes on strict refusal', async (launchedBy, launchOnly) => {
    const env = { WE_DAEMON_STATE_DIR: join(root, 'state'), WE_DAEMON_OVERLAY_DIR: join(root, 'overlays') };
    const file = pendingAdoptionPath(root, env);
    mkdirSync(join(env.WE_DAEMON_OVERLAY_DIR, 'adoption-pending'), { recursive: true });
    const original = Buffer.from(JSON.stringify([
      { ref: 'lane/overdue', sha: 'a'.repeat(40), at: new Date(Date.now() - 16 * 60_000).toISOString() }, {},
    ], null, 2) + '\n');
    writeFileSync(file, original);
    const emitEvent = vi.fn();
    const error = vi.fn();
    const pending = vi.spyOn(overlayAdoption, 'checkPendingAdoptions');
    const watch = vi.spyOn(forceAdopt, 'runForceWatchTick').mockResolvedValue({});
    const run = vi.fn(() => { throw new Error('unexpected git'); });
    const result = await rebuildClone({ root, env, asJob: true, launchOnly, launchedBy,
      emitEvent, run, log: { error } });
    expect(result.reason).toBe('state-unreadable');
    expect(readFileSync(file)).toEqual(original);
    expect(emitEvent).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(pending).not.toHaveBeenCalled();
    expect(watch).toHaveBeenCalledTimes(launchedBy === 'tick-start' ? 1 : 0);
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/state-unreadable.*repair/));
  });

it.each(['early', 'recovery'].flatMap(launchedBy =>
  ['state-unreadable', 'still-rejected', 'smoke-failed', 'future-refusal', 'rebuild-job-running'].map(reason => [launchedBy, reason])))(
  '%s launchOnly %s skips pending rewrites, failure alerts and force-watch', async (launchedBy, reason) => {
    const refused = { moved: false, reason, ...(reason === 'rebuild-job-running' ? { unknownJobState: true } : {}) };
    vi.spyOn(rebuildJob, 'rebuildCloneAsJob').mockResolvedValue(refused);
    const pending = vi.spyOn(overlayAdoption, 'checkPendingAdoptions').mockResolvedValue([]);
    const watch = vi.spyOn(forceAdopt, 'runForceWatchTick').mockResolvedValue({});
    const emitEvent = vi.fn();
    expect(await rebuildClone({ root, env: {}, asJob: true, launchOnly: true,
      launchedBy, emitEvent, log: { error() {} } })).toEqual(refused);
    expect(pending).not.toHaveBeenCalled();
    expect(watch).not.toHaveBeenCalled();
    expect(emitEvent).not.toHaveBeenCalled();
  });

it.each(['still-rejected', 'state-unreadable', 'future-refusal'])(
  'launchOnly preparation %s skips housekeeping writes after refusal', async reason => {
    const store = createJobStore(join(root, 'jobs'));
    const original = ' [ ] \n';
    const adopt = vi.fn(async () => {
      writeFileSync(join(store.dir, 'consumed.json'), original);
      return { moved: false, reason };
    });
    const evict = vi.fn();
    const reattach = vi.fn();
    const result = await rebuildCloneAsJob({ root, env: {}, store, adopt, evict, reattach,
      launchOnly: true, log: { error() {} } });
    expect(result.reason).toBe(reason);
    expect(readFileSync(join(store.dir, 'consumed.json'), 'utf8')).toBe(original);
    expect(evict).not.toHaveBeenCalled();
    expect(reattach).not.toHaveBeenCalled();
  });

it.each([
  { held: { reason: 'smoke-env-timeout', since: new Date(0).toISOString() } },
  { held: { reason: 'smoke-env-timeout', updatedAt: new Date(0).toISOString() } },
  { rejected: { inputsKey: 'historical-sticky-rejection' } },
  { held: null, rejected: null },
])('incomplete historical files require repair without migration at admission %j', state => {
  const env = { WE_DAEMON_STATE_DIR: join(root, 'state') };
  mkdirSync(env.WE_DAEMON_STATE_DIR);
  const file = rebuildStatePath(root, env);
  const bytes = JSON.stringify(state);
  writeFileSync(file, bytes);
  expect(() => readRebuildStateStrict(root, env)).toThrow();
  expect(readFileSync(file, 'utf8')).toBe(bytes);
});


it.each(['consumed.json', 'result'])('corrupt persisted %s refuses before changing job evidence', async fileKind => {
  mkdirSync(join(root, 'jobs'));
  const env = { WE_DAEMON_STATE_DIR: join(root, 'state') };
  const store = createJobStore(join(root, 'jobs'));
  const old = enqueueJob({ store, kindDef: REBUILD_JOB_KIND, codeSha: 'a'.repeat(40), input: { root } });
  store.update(old.id, r => markSucceeded(r, { at: new Date(1000).toISOString() }));
  const file = join(store.dir, fileKind === 'result' ? `${old.id}.result` : fileKind);
  writeFileSync(file, '{broken');
  const before = store.read(old.id);
  const adopt = vi.fn(); const reattach = vi.fn();
  const result = await rebuildCloneAsJob({ root, env, store, adopt, reattach, launchOnly: true, log: { error() {} } });
  expect(result.reason).toBe('state-unreadable');
  expect(adopt).not.toHaveBeenCalled(); expect(reattach).not.toHaveBeenCalled();
  expect(readFileSync(file, 'utf8')).toBe('{broken');
  expect(store.read(old.id)).toEqual(before);
  expect(store.list().records).toHaveLength(1);
});

// Complete persisted fixtures: mutation cases below bypass writers deliberately.
const stamp = new Date(0).toISOString();
const completeState = () => ({
  adopted: { head: 'head', inputsKey: 'inputs', mainSha: 'main', applied: [{ ref: 'lane/x', sha: 'tip' }], at: stamp },
  rejected: { inputsKey: 'inputs', reason: 'failed', at: stamp, retryAt: stamp, attempts: 1,
    harnessBroken: false, externalOnly: false, envLoad: false, dispatchSmoke: false },
  held: { reason: 'smoke-env-timeout', since: stamp, updatedAt: stamp, retryAt: stamp, attempts: 1 },
  inProgress: { pid: 1, host: 'host', startedAt: stamp, prevHead: 'head', target: 'target',
    inputsKey: 'inputs', mainSha: 'main', applied: [{ ref: 'lane/x', sha: 'tip' }], verified: true },
  quarantine: { prevHead: 'head', reason: 'failed' },
  unverified: { head: 'head', prevHead: 'previous' },
  building: { token: 'token', pid: 1, host: 'host', startedAt: stamp, target: 'target',
    inputsKey: 'inputs', path: 'candidate', adoptOnly: false },
  busySkippedTrees: ['tree'], forceUnverifiedTrees: ['tree'],
  smokePassed: [{ key: 'key', tree: 'tree', passedAt: stamp }], pinnedNotified: { 'lane/x': 'tip' },
});
const completeReady = () => ({
  kind: 'fallback', forced: false, prevHead: 'head', tree: 'tree', passedAt: stamp,
  adopt: { finalSha: 'target', inputsKey: 'inputs', mainSha: 'main', applied: [{ ref: 'lane/x', sha: 'tip' }] },
  forInputsKey: 'inputs', dropRefs: [{ ref: 'lane/y', sha: 'tip', pr: null }], failed: '',
});
function requiredPaths(value, prefix = []) {
  return Object.entries(value).flatMap(([key, child]) => {
    const path = [...prefix, key];
    return [path, ...(child && typeof child === 'object' ? requiredPaths(child, path) : [])];
  });
}
const requiredCases = [
  ...requiredPaths(completeState()).map(path => ['state', path]),
  ...requiredPaths(completeReady()).map(path => ['ready', path]),
].flatMap(([kind, path]) => (path[0] === 'pinnedNotified' && path.length > 1 ? ['wrong-type'] : ['missing', 'wrong-type']).map(mode => [kind, path.join('.'), mode]));

it.each(requiredCases)('%s required field %s %s refuses without changing evidence', async (kind, dotted, mode) => {
  const env = { WE_DAEMON_STATE_DIR: join(root, 'state') };
  mkdirSync(env.WE_DAEMON_STATE_DIR);
  const value = kind === 'state' ? completeState() : completeReady();
  const path = dotted.split('.');
  const parent = path.slice(0, -1).reduce((v, k) => v[k], value);
  const key = path.at(-1);
  // Removing an array member creates a malformed member, rather than shortening a valid list.
  if (mode === 'missing') { if (Array.isArray(parent)) parent[key] = null; else delete parent[key]; }
  else parent[key] = parent[key] === null ? true : typeof parent[key] === 'boolean' ? 'false' : typeof parent[key] === 'number' ? '1' : 42;
  const file = (kind === 'state' ? rebuildStatePath : readyCandidatePath)(root, env);
  const bytes = JSON.stringify(value, null, 2) + '\n';
  writeFileSync(file, bytes);
  const adopt = vi.fn(); const reattach = vi.fn();
  const store = createJobStore(join(root, 'jobs'));
  const result = await rebuildCloneAsJob({ root, env, store, launchOnly: true, adopt, reattach, log: { error() {} } });
  expect(result.reason).toBe('state-unreadable');
  expect(adopt).not.toHaveBeenCalled(); expect(reattach).not.toHaveBeenCalled();
  expect(readFileSync(file, 'utf8')).toBe(bytes);
  expect(nodeFs.existsSync(store.dir)).toBe(false);
});

it('complete declared state and ready schemas are admitted without coercion', () => {
  const env = { WE_DAEMON_STATE_DIR: join(root, 'state') };
  mkdirSync(env.WE_DAEMON_STATE_DIR);
  writeFileSync(rebuildStatePath(root, env), JSON.stringify(completeState()));
  writeFileSync(readyCandidatePath(root, env), JSON.stringify(completeReady()));
  expect(readRebuildStateStrict(root, env)).toEqual(completeState());
  expect(readReadyCandidateStrict(root, env)).toEqual(completeReady());
});

it.each([undefined, null, {}, [null], [{ ref: 'lane/x' }], [{ ref: 'lane/x', sha: 'tip', pinnedFrom: true }]])(
  'exact ready matching refuses incomplete applied evidence %j before an audit exemption', applied => {
    const auditedTip = vi.fn();
    const ready = completeReady(); ready.adopt.applied = applied; ready.kind = 'candidate';
    expect(matchReadyCandidate({ ready, auditedTip, plan: { finalSha: 'target', mainSha: 'main', alerts: [] },
      prevHead: 'head', nowMs: 1000, maxAgeMs: 2000 }).adopt).toBeNull();
  });

it('exact ready matching consults fresh audit evidence for each recorded tip', () => {
  const auditedTip = vi.fn(() => ({ ok: false }));
  const ready = completeReady(); ready.kind = 'candidate';
  const result = matchReadyCandidate({ ready, auditedTip,
    plan: { finalSha: 'target', mainSha: 'main', alerts: [] }, prevHead: 'head',
    stillWanted: () => true, nowMs: 1000, maxAgeMs: 2000 });
  expect(auditedTip).toHaveBeenCalled();
  expect(result.adopt).toBeNull();
});

it.each(['early', 'recovery'].flatMap(source => ['sticky', 'backoff', 'clean', 'interrupted', 'up-to-date'].map(kind => [source, kind])))(
  '%s %s admission uses one exact strict snapshot through real preparation and never rereads state', async (launchedBy, kind) => {
    const env = { WE_DAEMON_STATE_DIR: join(root, 'state'), WE_DAEMON_OVERLAY_DIR: join(root, 'overlays'),
      WE_DAEMON_CLONE_LOCK_ROOT: join(root, 'locks'), WE_DAEMON_AUTO_REBASE: '0' };
    writeRebuildState(root, ['clean', 'up-to-date'].includes(kind) ? {} : {
      rejected: { inputsKey: kind !== 'backoff' ? 'inputs' : 'older', reason: 'failed', at: stamp,
        ...(kind === 'backoff' ? { harnessBroken: true, retryAt: new Date(2000).toISOString() } : {}) },
      ...(kind === 'interrupted' ? { inProgress: { pid: 1, host: 'other-host', startedAt: new Date(-3600000).toISOString(),
        prevHead: 'head', target: 'head', inputsKey: 'inputs', mainSha: 'main', applied: [], verified: true } } : {}),
      ...(kind === 'backoff' ? { held: { reason: 'smoke-harness-broken', since: stamp, updatedAt: stamp,
        retryAt: null, attempts: 1 } } : {}),
    }, env);
    const file = rebuildStatePath(root, env), bytes = readFileSync(file, 'utf8');
    const snapshot = readRebuildStateStrict(root, env);
    const persistedRejection = structuredClone(snapshot.rejected);
    const readState = vi.fn(() => {
      if (readState.mock.calls.length > 1) throw new Error('second strict read forbidden');
      return snapshot;
    });
    const legacyRead = vi.spyOn(stateIO, 'readRebuildState').mockImplementation(() => { throw new Error('legacy read forbidden'); });
    const prepare = vi.spyOn(preparation, 'prepareRebuild');
    vi.spyOn(planner, 'planRebuild').mockImplementation(async () => {
      // Evidence arriving after strict admission is owned by the next tick.
      if (kind === 'up-to-date') writeFileSync(readyCandidatePath(root, env), '{new-unreadable-evidence');
      return { ok: true, upToDate: kind === 'up-to-date', finalSha: kind === 'up-to-date' ? 'head' : 'target',
        mainSha: 'main', inputsKey: 'inputs', applied: [], decisions: [], alerts: [] };
    });
    vi.spyOn(edgeFetch, 'fetchMainAndOverlays').mockReturnValue({ ok: true, goneRefs: [] });
    vi.spyOn(laneRepair, 'probeBrokenRefs').mockReturnValue({ probeFailed: false, broken: [] });
    vi.spyOn(laneRepair, 'diagnoseLane').mockReturnValue({ ok: true, problems: [] });
    const run = vi.fn(args => {
      if (args[0] === 'symbolic-ref') return { status: 0, stdout: 'main' };
      if (args[0] === 'rev-parse') return args.includes('MERGE_HEAD') ? { status: 1, stdout: '' } : { status: 0, stdout: 'head' };
      if (['commit-graph', 'ls-files', 'status', 'rev-list'].includes(args[0])) return { status: 0, stdout: '' };
      throw new Error('unexpected git: ' + args.join(' '));
    });
    const actualJob = rebuildJob.rebuildCloneAsJob;
    const store = createJobStore(join(root, 'jobs'));
    vi.spyOn(rebuildJob, 'rebuildCloneAsJob').mockImplementation(options => actualJob({ ...options, store, readState,
      codeSha: 'a'.repeat(40), reattach: async () => ({}), evict() {},
      settings: { minIntervalMs: 0, minIntervalJitterPct: 0 } }));
    const result = await rebuildClone({ root, env, run, asJob: true, launchOnly: true, launchedBy,
      versions: null, now: () => 1000, lockOpts: { waitMs: 0 }, log: { error() {} }, emitEvent: vi.fn() });
    expect(result.reason).toBe(['sticky', 'interrupted'].includes(kind) ? 'still-rejected' : kind === 'backoff'
      ? 'smoke-harness-broken-backoff' : kind === 'up-to-date' ? 'up-to-date' : 'rebuild-job-started');
    expect(readState).toHaveBeenCalledOnce(); expect(legacyRead).not.toHaveBeenCalled();
    expect(prepare.mock.calls[0][0].admissionEvidence.state).toBe(snapshot);
    if (kind === 'interrupted') {
      const persisted = JSON.parse(readFileSync(file, 'utf8'));
      expect(persisted.inProgress).toBeNull();
      expect(persisted.rejected).toEqual(persistedRejection);
    } else if (kind === 'up-to-date') {
      expect(readFileSync(readyCandidatePath(root, env), 'utf8')).toBe('{new-unreadable-evidence');
      expect(JSON.parse(readFileSync(file, 'utf8')).adopted.head).toBe('head');
    } else expect(readFileSync(file, 'utf8')).toBe(bytes);
    expect(store.list().records).toHaveLength(kind === 'clean' ? 1 : 0);
  });

it('lost launch-only snapshot handoff refuses before any legacy read or Git IO', async () => {
  const legacy = vi.spyOn(stateIO, 'readRebuildState').mockImplementation(() => { throw new Error('legacy read forbidden'); });
  const run = vi.fn();
  const result = await rebuildClone({ root, env: {}, readyOnly: true, adoptOnly: true, asJob: false,
    run, emitEvent: vi.fn(), log: { error() {} } });
  expect(result.reason).toBe('state-unreadable');
  const prepared = await preparation.prepareRebuild({ root, env: {}, readyOnly: true, adoptOnly: true, run });
  expect(prepared.result.reason).toBe('state-unreadable');
  expect(legacy).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled();
});
