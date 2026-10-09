/**
 * @file scripts/conveyor/__tests__/health-watch-jobs.test.mjs
 * @description #4131 — the health tick's gh-probe JOB path (tick side). A due gh cadence queues ONE detached
 *   `health-gh-probe` job and the tick returns without probing; repeated ticks never duplicate the job; a
 *   finished job's result is consumed exactly once; a failed job is a probe error; old consumed records are
 *   pruned; the sleep rule works across separate tick processes. Real job store on a temp dir; the launch is a
 *   fake (no child process) — the real detached child is health-watch-job.test.mjs.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { tick } from '../health-watch.mjs';
import { healthDir } from '../health-watch-section.mjs';
import {
  runGhProbeJobs, observeTickClock, resolveHealthJobSwitches, FINISHED_JOB_KEEP_MS, RESULT_SUFFIX,
} from '../health-watch-job.mjs';
import { createJobStore } from '../../lib/daemon-jobs-runtime.mjs';
import { markClaimed, markLaunching, markSucceeded, markFailed } from '../../lib/daemon-jobs.mjs';
import { HEALTH_WATCH_JOB_KINDS, HEALTH_WATCH_JOB_CAP } from '../../../skills-src/conveyor/daemon-manifest.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'health-jobs-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const iso = (ms) => new Date(ms).toISOString();
/** A reattach that never spawns: records which kinds/cap it was handed and leaves queued jobs queued. */
function fakeReattach(calls = []) {
  return async (o) => { calls.push({ kinds: o.kinds, maxConcurrent: o.maxConcurrent, observation: o.observation }); return { slept: o.observation.slept, gapMs: o.observation.gapMs, actions: [], corrupt: [] }; };
}
/** Drive a queued record to succeeded, writing its result sidecar the way the job child does. */
function finish(store, id, { at, probes = { prs: [], agents: [] }, errors = {} }) {
  store.update(id, (r) => markLaunching(r, { at: iso(at) }));
  store.update(id, (r) => markClaimed(r, { at: iso(at), handle: `h:${process.pid}:x`, host: 'h', pid: process.pid, procStart: 'x' }));
  writeFileSync(join(store.dir, `${id}${RESULT_SUFFIX}`), JSON.stringify({ jobId: id, sampledAt: at, probes, errors }));
  store.update(id, (r) => markSucceeded(r, { at: iso(at) }));
}
const noEvict = () => ({ evicted: [] });

describe('runGhProbeJobs — tick side of the health-gh-probe job', () => {
  const base = (store, calls) => ({ store, codeSha: 'abc123', reattach: fakeReattach(calls), evict: noEvict, input: { sourceRoot: dir } });

  it('queues exactly one job when due, never a duplicate while it is in flight, and hands reattach the health kinds + cap', async () => {
    const store = createJobStore(join(dir, 'jobs'));
    const calls = [];
    const a = await runGhProbeJobs({ ...base(store, calls), now: 1_000_000, due: true });
    expect(a.summary.enqueued).toBeTruthy();
    expect(a.result).toBeNull();
    const b = await runGhProbeJobs({ ...base(store, calls), now: 1_060_000, due: true, state: a.state });
    expect(b.summary.enqueued).toBeNull();
    expect(b.summary.inFlight.id).toBe(a.summary.enqueued);
    expect(store.list().records).toHaveLength(1);
    expect(calls[0].kinds).toBe(HEALTH_WATCH_JOB_KINDS);
    expect(calls[0].maxConcurrent).toBe(HEALTH_WATCH_JOB_CAP);
    expect(store.read(a.summary.enqueued).job.codeSha).toBe('abc123');
  });

  it('consumes a finished result exactly once, and a failed job once as a failure', async () => {
    const store = createJobStore(join(dir, 'jobs'));
    const q = await runGhProbeJobs({ ...base(store), now: 1_000_000, due: true });
    finish(store, q.summary.enqueued, { at: 1_100_000, probes: { prs: [{ number: 1 }], agents: [] }, errors: { staleState: 'boom' } });
    const c = await runGhProbeJobs({ ...base(store), now: 1_200_000, due: true, state: q.state });
    expect(c.result).toMatchObject({ jobId: q.summary.enqueued, sampledAt: 1_100_000, probes: { prs: [{ number: 1 }] }, errors: { staleState: 'boom' } });
    expect(c.summary.enqueued).toBeNull(); // a fresh result was just consumed
    const d = await runGhProbeJobs({ ...base(store), now: 1_260_000, due: false, state: c.state });
    expect(d.result).toBeNull();
    expect(d.failure).toBeNull();

    const e = await runGhProbeJobs({ ...base(store), now: 1_300_000, due: true, state: d.state });
    store.update(e.summary.enqueued, (r) => markFailed(r, { at: iso(1_310_000), reason: 'handle dead; 3/3 attempts used' }));
    const f = await runGhProbeJobs({ ...base(store), now: 1_320_000, due: false, state: e.state });
    expect(f.failure).toMatch(/failed: handle dead; 3\/3 attempts used/);
    const g = await runGhProbeJobs({ ...base(store), now: 1_330_000, due: false, state: f.state });
    expect(g.failure).toBeNull();
  });

  it('prunes consumed finished records older than the keep window, with their result sidecar', async () => {
    const store = createJobStore(join(dir, 'jobs'));
    const q = await runGhProbeJobs({ ...base(store), now: 1_000_000, due: true });
    const id = q.summary.enqueued;
    finish(store, id, { at: 1_000_000 });
    const c = await runGhProbeJobs({ ...base(store), now: 1_100_000, due: false, state: q.state });
    expect(c.state.consumed).toContain(id);
    expect(existsSync(join(store.dir, `${id}${RESULT_SUFFIX}`))).toBe(true);
    const later = await runGhProbeJobs({ ...base(store), now: 1_000_000 + FINISHED_JOB_KEEP_MS + 1, due: false, state: c.state });
    expect(later.summary.pruned).toEqual([id]);
    expect(store.read(id)).toBeNull();
    expect(existsSync(join(store.dir, `${id}${RESULT_SUFFIX}`))).toBe(false);
    expect(later.state.consumed).not.toContain(id);
  });

  it('applies the sleep rule across separate tick processes from the persisted wall/monotonic sample', async () => {
    expect(observeTickClock(null, { wallMs: 100, monoMs: 50 }).observation.slept).toBe(false);
    const awake = observeTickClock({ wallMs: 0, monoMs: 0 }, { wallMs: 300_000, monoMs: 299_000 });
    expect(awake.observation.slept).toBe(false);
    const slept = observeTickClock({ wallMs: 0, monoMs: 0 }, { wallMs: 3_600_000, monoMs: 300_000 });
    expect(slept.observation.slept).toBe(true);
    // A monotonic clock that went backwards is a reboot: the old sample is discarded, never read as a sleep.
    expect(observeTickClock({ wallMs: 0, monoMs: 9e9 }, { wallMs: 3_600_000, monoMs: 1000 }).observation.slept).toBe(false);
    const store = createJobStore(join(dir, 'jobs'));
    const calls = [];
    await runGhProbeJobs({ ...base(store, calls), now: 1, due: false, state: { clock: { wallMs: 0, monoMs: 0 } }, wallNow: () => 3_600_000, monoNow: () => 300_000 });
    expect(calls[0].observation.slept).toBe(true);
  });

  it('switches default to the manifest value and honour a config override', () => {
    expect(typeof resolveHealthJobSwitches({}).ghProbes).toBe('boolean');
    expect(resolveHealthJobSwitches({ jobs: { ghProbes: false } }).ghProbes).toBe(false);
    expect(resolveHealthJobSwitches({ jobs: { ghProbes: true } }).ghProbes).toBe(true);
    expect(resolveHealthJobSwitches({ jobs: { ghProbes: 'yes' } }).ghProbes).toBe(resolveHealthJobSwitches({}).ghProbes);
  });
});

describe('tick — the gh cadence as a job never blocks the tick', () => {
  function setup(name) {
    const stateRoot = join(dir, `${name}-state`); const hd = healthDir(stateRoot); mkdirSync(hd, { recursive: true });
    const lockRoot = join(dir, `${name}-locks`); mkdirSync(lockRoot);
    const empty = join(dir, 'empty.json'); writeFileSync(empty, '{}');
    const flags = {
      'state-root': stateRoot, 'lock-root': lockRoot, 'logs-dir': join(dir, 'logs'), 'self-sync-dir': join(dir, 'sync'),
      'no-diagnose': true, 'no-investigate': true, 'no-file': true, 'no-notify': true,
      'graphql-budget-fixture': empty, 'rest-budget-fixture': empty, 'credential-inventory-fixture': empty,
    };
    return { flags, hd };
  }
  const neverInline = () => { throw new Error('the gh probes ran inline inside the tick'); };

  it('queues one job, returns without probing, never duplicates it, then consumes its result once', async () => {
    const { flags } = setup('job');
    const store = createJobStore(join(dir, 'jobs'));
    const deps = { collectGh: neverInline, ghJobs: { store, codeSha: 'abc123', reattach: fakeReattach(), evict: noEvict } };
    const t0 = Date.parse('2026-10-09T12:00:00Z');

    const first = await tick({ ...flags, now: iso(t0) }, deps);
    expect(first.ghJob.enqueued).toBeTruthy();
    expect(first.ghSampled).toBe(false);
    const id = first.ghJob.enqueued;

    const second = await tick({ ...flags, now: iso(t0 + 300_000) }, deps);
    expect(second.ghJob.enqueued).toBeNull();
    expect(second.ghJob.inFlight.id).toBe(id);
    expect(store.list().records).toHaveLength(1);

    finish(store, id, { at: t0 + 400_000, probes: { prs: [], agents: [] } });
    const third = await tick({ ...flags, now: iso(t0 + 600_000) }, deps);
    expect(third.ghJob.consumed).toBe(id);
    expect(third.ghSampled).toBe(true);

    const fourth = await tick({ ...flags, now: iso(t0 + 900_000) }, deps);
    expect(fourth.ghJob.consumed).toBeNull();
    expect(fourth.ghSampled).toBe(false);
    expect(fourth.ghJob.enqueued).toBeNull(); // ghCache.at = the job's sample time: not due again yet
    expect(store.list().records).toHaveLength(1);
  }, 30000);

  it('a failed job is a probe error, and the gh cadence stays due', async () => {
    const { flags } = setup('fail');
    const store = createJobStore(join(dir, 'jobs'));
    const deps = { collectGh: neverInline, ghJobs: { store, codeSha: 'abc123', reattach: fakeReattach(), evict: noEvict } };
    const t0 = Date.parse('2026-10-09T12:00:00Z');
    const first = await tick({ ...flags, now: iso(t0) }, deps);
    store.update(first.ghJob.enqueued, (r) => markFailed(r, { at: iso(t0 + 1000), reason: 'handle dead; 3/3 attempts used' }));
    const second = await tick({ ...flags, now: iso(t0 + 300_000) }, deps);
    expect(second.probeErrors.ghJob).toMatch(/3\/3 attempts used/);
    expect(second.ghSampled).toBe(false);
    // The cadence stays due, so the same tick queues a fresh job (the runtime already spent the retries).
    expect(second.ghJob.enqueued).toBeTruthy();
    expect(second.ghJob.enqueued).not.toBe(first.ghJob.enqueued);
  }, 30000);

  it('with the switch off (a fixture tick, no job deps) the gh group still runs inline when due', async () => {
    const { flags } = setup('inline');
    let calls = 0;
    const collectGh = () => { calls++; return { probes: { prs: [], agents: [] }, errors: {} }; };
    const out = await tick({ ...flags, now: '2026-10-09T12:00:00Z' }, { collectGh });
    expect(calls).toBe(1);
    expect(out.ghSampled).toBe(true);
    expect(out.ghJob).toBeNull();
  }, 30000);
});
