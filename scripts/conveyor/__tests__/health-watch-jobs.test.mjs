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
  function setup(name, { ghProbes = true } = {}) {
    const stateRoot = join(dir, `${name}-state`); const hd = healthDir(stateRoot); mkdirSync(hd, { recursive: true });
    // The switch is always explicit here, so these cases do not move when the manifest default flips.
    writeFileSync(join(hd, 'config.json'), JSON.stringify({ jobs: { ghProbes } }));
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

  const inlineSpy = () => {
    const spy = { calls: 0 };
    spy.fn = () => { spy.calls++; return { probes: { prs: [], agents: [] }, errors: {} }; };
    return spy;
  };

  it('the switch, a dry run and a fixture tick each keep the group inline', async () => {
    const off = setup('off', { ghProbes: false });
    const spyOff = inlineSpy();
    const store = createJobStore(join(dir, 'jobs-off'));
    const a = await tick({ ...off.flags, now: '2026-10-09T12:00:00Z' }, { collectGh: spyOff.fn, ghJobs: { store, codeSha: 'x', reattach: fakeReattach(), evict: noEvict } });
    expect(spyOff.calls).toBe(1);
    expect(a.ghJob).toBeNull();
    expect(store.list().records).toHaveLength(0);

    const dry = setup('dry');
    const spyDry = inlineSpy();
    const b = await tick({ ...dry.flags, 'dry-run': true, now: '2026-10-09T12:00:00Z' }, { collectGh: spyDry.fn, ghJobs: { store, codeSha: 'x', reattach: fakeReattach(), evict: noEvict } });
    expect(spyDry.calls).toBe(1);
    expect(b.ghJob).toBeNull();
    expect(store.list().records).toHaveLength(0);

    // A fixture tick with the switch on but no job store of its own never reaches the host's job store.
    const fx = setup('fixture');
    const spyFx = inlineSpy();
    const c = await tick({ ...fx.flags, now: '2026-10-09T12:00:00Z' }, { collectGh: spyFx.fn });
    expect(spyFx.calls).toBe(1);
    expect(c.ghJob).toBeNull();
  }, 30000);

  it('a job-runtime error is a probe error on a finished tick, never an aborted one', async () => {
    const { flags } = setup('throws');
    const store = createJobStore(join(dir, 'jobs-throws'));
    const reattach = async () => { throw new Error('jobs dir unwritable'); };
    const out = await tick({ ...flags, now: '2026-10-09T12:00:00Z' }, { collectGh: neverInline, ghJobs: { store, codeSha: 'x', reattach, evict: noEvict } });
    expect(out.probeErrors.ghJob).toMatch(/jobs dir unwritable/);
    expect(out.ghSampled).toBe(false);
    expect(out.reports).toBeDefined();
  }, 30000);

  it('a rollback still reconciles the in-flight job; a result too old to be current is never applied', async () => {
    const on = setup('rollback');
    const store = createJobStore(join(dir, 'jobs-rollback'));
    const t0 = Date.parse('2026-10-09T12:00:00Z');
    const jobs = { store, codeSha: 'x', reattach: fakeReattach(), evict: noEvict };
    const first = await tick({ ...on.flags, now: iso(t0) }, { collectGh: neverInline, ghJobs: jobs });
    const id = first.ghJob.enqueued;
    // Switch off while the job is in flight: the group runs inline, the job is still reconciled, nothing new queued.
    writeFileSync(join(on.hd, 'config.json'), JSON.stringify({ jobs: { ghProbes: false } }));
    const spy = inlineSpy();
    const second = await tick({ ...on.flags, now: iso(t0 + 300_000) }, { collectGh: spy.fn, ghJobs: jobs });
    expect(spy.calls).toBe(1);
    expect(second.ghJob.inFlight.id).toBe(id);
    expect(second.ghJob.enqueued).toBeNull();
    // The old job finishes long after: its result is consumed but never applied as the current sample.
    finish(store, id, { at: t0 + 400_000 });
    const late = await tick({ ...on.flags, now: iso(t0 + 400_000 + 31 * 60_000) }, { collectGh: spy.fn, ghJobs: jobs });
    expect(late.ghJob.stale).toEqual([id]);
    expect(late.ghJob.consumed).toBeNull();
    expect(late.ghJob.remaining).toBe(0);
    // Nothing left to reconcile: the job state is dropped and later ticks no longer touch the job store.
    const after = await tick({ ...on.flags, now: iso(t0 + 400_000 + 60 * 60_000) }, { collectGh: spy.fn, ghJobs: jobs });
    expect(after.ghJob).toBeNull();
  }, 30000);

  it('runs an identical diagnosis once per tick and defers the rest past the budget, so the tick is never killed', async () => {
    // Live 2026-10-09: nine stale-claim episodes opened at once, each ran the same 30 s sweep, the watchdog killed
    // the tick at 180 s, nothing was saved, and the next tick reopened all nine.
    const fake = (id, cmdArg) => ({
      id, probes: ['machineLoad'], severity: 'medium', openAfter: 1, diagnose: { command: 'node', args: ['-e', cmdArg] },
      evaluate: () => ['a', 'b', 'c'].map((x) => ({ subject: x, breach: true, measure: {}, summary: `${id} ${x}`, recommendation: 'r' })),
    });
    const { flags } = setup('diag', { ghProbes: false });
    const calls = [];
    const runDiagnosis = (cmd, args) => { calls.push(args.join(' ')); return 'ok'; };
    const out = await tick({ ...flags, 'no-gh': true, 'no-diagnose': false, now: '2026-10-09T12:00:00Z' },
      { smells: [fake('fake-one', 'one'), fake('fake-two', 'two')], runDiagnosis });
    expect(calls.sort()).toEqual(['-e one', '-e two']);
    expect(out.diagnoses).toHaveLength(6);
    expect(out.probeErrors.diagnoseDeferred).toBeUndefined();

    const late = setup('diag-late', { ghProbes: false });
    const lateCalls = [];
    const past = await tick({ ...late.flags, 'no-gh': true, 'no-diagnose': false, now: '2026-10-09T12:00:00Z' },
      { smells: [fake('fake-one', 'one')], runDiagnosis: (c, a) => { lateCalls.push(a); return 'ok'; }, clock: () => Date.now() + 10 * 60_000 });
    expect(lateCalls).toHaveLength(0);
    expect(past.diagnoses).toHaveLength(0);
    expect(past.probeErrors.diagnoseDeferred).toMatch(/^3 diagnosis\(es\) skipped past the tick budget/);
  }, 30000);
});
