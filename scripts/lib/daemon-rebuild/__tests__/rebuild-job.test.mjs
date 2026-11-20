/** Rebuild herd spacing: stable identity, bounded additive jitter, and historical settings. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { loadRebuildAsJobSettings, rebuildJobInterval, rebuildCloneAsJob, REBUILD_JOB_KIND } from '../rebuild-job.mjs';
import { createJobStore, enqueueJob } from '../../daemon-jobs-runtime.mjs';
import { writeReadyCandidate, readReadyCandidate } from '../state.mjs';
import { markSucceeded } from '../../daemon-jobs.mjs';

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
  const env = { WE_DAEMON_STATE_DIR: join(root, 'state'), WE_DAEMON_CLONE_LOCK_ROOT: join(root, 'locks') };
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


describe('hot-patch one-shot wake through the rebuild-job-spaced cooldown', () => {
  let hotPatch, env, store, ledger, plan;
  const finished = 1700000000000;
  beforeEach(async () => {
    // Keep the existing suite runnable on main; only these new cases require S2-min.
    const modulePath = join(process.cwd(), 'scripts/lib/hot-patch.mjs');
    const moduleUrl = pathToFileURL(modulePath).href;
    hotPatch = existsSync(modulePath) ? await import(/* @vite-ignore */ moduleUrl) : {};
    env = { WE_DAEMON_STATE_DIR: join(root, 'state'), WE_DAEMON_CLONE_LOCK_ROOT: join(root, 'locks') };
    mkdirSync(env.WE_DAEMON_STATE_DIR);
    mkdirSync(join(root, 'jobs'));
    store = createJobStore(join(root, 'jobs'));
    const old = enqueueJob({ store, kindDef: REBUILD_JOB_KIND, codeSha: 'a'.repeat(40), input: { root }, now: finished - 1000 });
    store.update(old.id, r => markSucceeded(r, { at: new Date(finished).toISOString() }));
    const sha = 'b'.repeat(40);
    ledger = { sha, pr: 42, branch: 'lane/repair', root, requestPid: process.pid, requestStart: 1,
      loadedAt: new Date(finished).toISOString(),
      overlay: { ref: 'lane/repair', pr: 42, pinned: true, reason: 'R1100 hot-patch',
        addedAt: new Date(finished).toISOString(), addedBy: null },
      preGood: { head: 'a'.repeat(40), inputsKey: 'c'.repeat(40), mainSha: 'a'.repeat(40), applied: [] } };
    plan = { finalSha: sha, applied: [{ ref: ledger.branch, sha }] };
    writeFileSync(hotPatch.hotPatchLedgerPath(env), JSON.stringify(ledger));
  });
  const tick = (elapsed = 120000, extra = {}) => {
    vi.spyOn(Date, 'now').mockReturnValue(finished + elapsed);
    return rebuildCloneAsJob({
    root, env, store, entries: ['scripts/review-daemon.mjs'],
    adopt: async () => ({ reason: 'needs-build', plan }),
    reattach: async () => ({}), evict: () => ({}), log: { error() {} }, codeSha: 'a'.repeat(40),
    now: () => finished + elapsed, rng: () => 0,
    settings: { entries: [], minIntervalMs: 900000, minIntervalJitterPct: 0 }, ...extra,
  }); };
  it('skips the 900000ms cooldown exactly once and persists wokeAt before enqueue', async () => {
    expect(hotPatch.WAKE_FLOOR_MS).toBe(120000);
    const create = vi.spyOn(store, 'create');
    create.mockImplementationOnce(record => {
      expect(hotPatch.readHotPatch(env).wokeAt).toBeTruthy();
      // Call the real store on the same directory to observe the persistence boundary.
      return createJobStore(store.dir).create(record);
    });
    expect((await tick()).reason).toBe('rebuild-job-started');
    expect(create).toHaveBeenCalledTimes(1);
    expect(hotPatch.readHotPatch(env).wokeAt).toBeTruthy();
    const queued = store.list().records.find(r => r.id !== create.mock.results[0].value.id);
    expect(queued).toBeTruthy();
    const newJob = create.mock.results[0].value;
    store.update(newJob.id, r => markSucceeded(r, { at: new Date(finished + 120000).toISOString() }));
    expect((await tick(240000)).reason).toBe('rebuild-job-spaced');
    expect(create).toHaveBeenCalledTimes(1);
  });
  it('never wakes within WAKE_FLOOR_MS of last finish', async () => {
    expect((await tick(119999)).reason).toBe('rebuild-job-spaced');
    expect(store.list().records).toHaveLength(1);
    expect(hotPatch.readHotPatch(env).wokeAt).toBeUndefined();
  });
  it('never wakes without a ledger', async () => {
    rmSync(hotPatch.hotPatchLedgerPath(env));
    expect((await tick()).reason).toBe('rebuild-job-spaced');
    expect(store.list().records).toHaveLength(1);
  });
  it('never wakes for another sha', async () => {
    plan = { ...plan, applied: [{ ref: ledger.branch, sha: 'd'.repeat(40) }] };
    expect((await tick()).reason).toBe('rebuild-job-spaced');
    expect(hotPatch.readHotPatch(env).wokeAt).toBeUndefined();
  });
  it('never wakes for another branch even with the same sha', async () => {
    plan = { ...plan, applied: [{ ref: 'lane/other', sha: ledger.sha }] };
    expect((await tick()).reason).toBe('rebuild-job-spaced');
  });
  it('unreadable ledger fails closed to the ordinary cooldown', async () => {
    writeFileSync(hotPatch.hotPatchLedgerPath(env), '{bad');
    expect((await tick()).reason).toBe('rebuild-job-spaced');
    expect(store.list().records).toHaveLength(1);
  });
  it('R3.2 a throwing wake claim keeps every tick spaced and never queues within cooldown', async () => {
    const claimHotPatchWake = vi.fn(async () => { throw Error('disk busy'); });
    const create = vi.spyOn(store, 'create');
    expect((await tick(120000, { claimHotPatchWake })).reason).toBe('rebuild-job-spaced');
    expect((await tick(300000, { claimHotPatchWake })).reason).toBe('rebuild-job-spaced');
    expect(create).not.toHaveBeenCalled();
    expect(claimHotPatchWake).toHaveBeenCalledTimes(2);
    expect(claimHotPatchWake).toHaveBeenCalledWith(env, root, plan, finished);
  });
  it('R3.1 two ticks three minutes apart consume only one wake even if enqueue throws', async () => {
    const create = vi.spyOn(store, 'create').mockImplementationOnce(() => { throw Error('disk full'); });
    expect((await tick(120000)).reason).toBe('rebuild-job-queue-failed');
    expect((await tick(300000)).reason).toBe('rebuild-job-spaced');
    expect(create).toHaveBeenCalledTimes(1);
    expect(hotPatch.readHotPatch(env).wokeAt).toBeTruthy();
    expect(store.list().records).toHaveLength(1);
  });
});
