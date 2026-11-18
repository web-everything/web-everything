/** Rebuild herd spacing: stable identity, bounded additive jitter, and historical settings. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
  expect(reattach).toHaveBeenCalledTimes(phase === 'before-reattach' ? 0 : 1);
  expect(adopt).toHaveBeenCalledTimes(1);
});
