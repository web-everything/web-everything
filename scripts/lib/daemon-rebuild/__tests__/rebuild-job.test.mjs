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
    adopt: { finalSha: 'ready', applied: [] } };
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
  ['sticky rejection', { rejected: { inputsKey: 'unchanged' } }, 'still-rejected'],
  ['smoke backoff', { held: { reason: 'smoke-harness-broken', since: new Date(0).toISOString() },
    rejected: { inputsKey: 'older', harnessBroken: true, retryAt: new Date(2000).toISOString() } }, 'smoke-harness-broken-backoff'],
  ['retry not yet due', { rejected: { inputsKey: 'unchanged', retryAt: new Date(2000).toISOString() } }, 'still-rejected'],
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
  else expect(adopt).toHaveBeenCalledWith({ readyOnly: true });
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

it.each(['early', 'recovery'])(
  '%s launchOnly preserves mixed overdue and malformed pending-adoption bytes on strict refusal', async launchedBy => {
    const env = { WE_DAEMON_STATE_DIR: join(root, 'state'), WE_DAEMON_OVERLAY_DIR: join(root, 'overlays') };
    const file = pendingAdoptionPath(root, env);
    mkdirSync(join(env.WE_DAEMON_OVERLAY_DIR, 'adoption-pending'), { recursive: true });
    const original = Buffer.from(JSON.stringify([
      { ref: 'lane/overdue', sha: 'a'.repeat(40), at: new Date(Date.now() - 16 * 60_000).toISOString() }, {},
    ], null, 2) + '\n');
    writeFileSync(file, original);
    const emitEvent = vi.fn();
    const run = vi.fn(() => { throw new Error('unexpected git'); });
    const result = await rebuildClone({ root, env, asJob: true, launchOnly: true, launchedBy,
      emitEvent, run, log: { error() {} } });
    expect(result.reason).toBe('state-unreadable');
    expect(readFileSync(file)).toEqual(original);
    expect(emitEvent).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

it.each(['state-unreadable', 'still-rejected', 'smoke-failed', 'future-refusal', 'rebuild-job-running'])(
  'launchOnly %s skips pending rewrites, failure alerts and force-watch', async reason => {
    const refused = { moved: false, reason, ...(reason === 'rebuild-job-running' ? { unknownJobState: true } : {}) };
    vi.spyOn(rebuildJob, 'rebuildCloneAsJob').mockResolvedValue(refused);
    const pending = vi.spyOn(overlayAdoption, 'checkPendingAdoptions').mockResolvedValue([]);
    const watch = vi.spyOn(forceAdopt, 'runForceWatchTick').mockResolvedValue({});
    const emitEvent = vi.fn();
    expect(await rebuildClone({ root, env: {}, asJob: true, launchOnly: true,
      launchedBy: 'tick-start', emitEvent })).toEqual(refused);
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
])('strict admission preserves historical persisted state %j', state => {
  const env = { WE_DAEMON_STATE_DIR: join(root, 'state') };
  writeRebuildState(root, state, env);
  expect(readRebuildStateStrict(root, env)).toMatchObject(state);
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
