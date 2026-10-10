/**
 * @file scripts/conveyor/__tests__/health-watch-jobs.test.mjs
 * @description #4131 — the health tick's gh-probe JOB path (tick side). A due gh cadence queues ONE detached
 *   `health-gh-probe` job and the tick returns without probing; repeated ticks never duplicate the job; a
 *   finished job's result is consumed exactly once; a failed job is a probe error; old consumed records are
 *   pruned; the sleep rule works across separate tick processes. Real job store on a temp dir; the launch is a
 *   fake (no child process) — the real detached child is health-watch-job.test.mjs.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync, utimesSync, symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { tick, collectGhProbes, GH_GROUP_PROBE_NAMES, GH_CADENCE_MS, cadenceDue } from '../health-watch.mjs';
import { healthDir } from '../health-watch-section.mjs';
import {
  runGhProbeJobs, observeTickClock, resolveHealthJobSwitches, FINISHED_JOB_KEEP_MS, RESULT_SUFFIX,
  prewarmSnapshots, prewarmMain, requestPrewarm, snapshotWarm, createWarmGate, evictToTrash, sweepTrash, isSafeCodeSha,
  PREWARM_MAX_MS, PREWARM_BACKOFF_BASE_MS, PREWARM_MAX_ATTEMPTS, PREWARM_FAILED_HOLD_MS,
} from '../health-watch-job.mjs';
import { createJobStore } from '../../lib/daemon-jobs-runtime.mjs';
import { markClaimed, markLaunching, markSucceeded, markFailed, markRequeued } from '../../lib/daemon-jobs.mjs';
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

  describe('the result sidecar is untrusted input (user-writable directory)', () => {
    /** Finish a queued job with a raw sidecar body, so a hostile file is written byte for byte. */
    let n = 0;
    async function consumeRaw(body, over = {}, now = 1_200_000) {
      const store = createJobStore(join(dir, `raw-${n += 1}`));
      const q = await runGhProbeJobs({ ...base(store), now: 1_000_000, due: true });
      const id = q.summary.enqueued;
      store.update(id, (r) => markLaunching(r, { at: iso(1_100_000) }));
      store.update(id, (r) => markClaimed(r, { at: iso(1_100_000), handle: `h:${process.pid}:x`, host: 'h', pid: process.pid, procStart: 'x' }));
      const path = join(store.dir, `${id}${RESULT_SUFFIX}`);
      if (typeof body === 'function') body(path); // a non-regular file in the sidecar's place
      else writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body));
      store.update(id, (r) => markSucceeded(r, { at: iso(1_100_000) }));
      return runGhProbeJobs({ ...base(store), now, due: true, state: q.state, ...over });
    }

    it('rejects a sampledAt in the future instead of parking the gh cadence behind it', async () => {
      const out = await consumeRaw({ sampledAt: 1_200_000 + 1e10, probes: { prs: [], agents: [] }, errors: {} });
      expect(out.result).toBeNull();
      expect(out.failure).toMatch(/future/);
    });

    it('still accepts a sampledAt a little ahead of now (clock skew), but no further than the allowance', async () => {
      const ok = await consumeRaw({ sampledAt: 1_200_000 + 60_000, probes: { prs: [], agents: [] }, errors: {} });
      expect(ok.result).not.toBeNull();
      const bad = await consumeRaw({ sampledAt: 1_200_000 + 10 * 60_000, probes: { prs: [], agents: [] }, errors: {} });
      expect(bad.result).toBeNull();
    });

    it('drops every probe and error key outside the gh group — processes, daemonLogs and an own __proto__ key', async () => {
      const raw = '{"sampledAt":1100000,"probes":{"prs":[1],"agents":[],"processes":["evil"],"daemonLogs":{"x":1},"__proto__":{"polluted":true}},'
        + '"errors":{"staleState":"boom","processes":"hide it","__proto__":{"p":1}}}';
      const out = await consumeRaw(raw);
      expect(Object.keys(out.result.probes).sort()).toEqual(['agents', 'prs']);
      expect(Object.keys(out.result.errors)).toEqual(['staleState']);
      expect(Object.getPrototypeOf(out.result.probes)).toBe(Object.prototype);
      expect(out.result.probes.polluted).toBeUndefined();
      expect(out.summary.dropped.sort()).toEqual(['__proto__', 'daemonLogs', 'processes']);
    });

    it('never echoes an untrusted key name raw: odd names become <invalid>, and the list is capped', async () => {
      const keys = { 'evil\nkey`x': 1, 'a b': 1, 'ok_name': 1, ...Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, 1])) };
      const out = await consumeRaw({ sampledAt: 1_100_000, probes: { prs: [], agents: [], ...keys }, errors: {} });
      expect(out.summary.dropped.length).toBeLessThanOrEqual(10);
      for (const name of out.summary.dropped) expect(name).toMatch(/^([A-Za-z0-9_$]{1,64}|<invalid>)$/);
      expect(out.summary.dropped).toContain('<invalid>');
      expect(JSON.stringify(out.summary)).not.toMatch(/evil|\\u2028/);
    });

    it('keeps only the first line of an error text, with credentials redacted, as the inline path does', async () => {
      const out = await consumeRaw({ sampledAt: 1_100_000, probes: { prs: [], agents: [] },
        errors: { staleState: 'boom ghp_abcdefghijklmnopqrstuvwxyz0123456789\nsecond line `x`' } });
      expect(out.result.errors.staleState).toBe('boom [redacted]');
    });

    it('a sampledAt a little ahead of now is clamped to now, so it can never outlast the cadence', async () => {
      const out = await consumeRaw({ sampledAt: 1_200_000 + 60_000, probes: { prs: [], agents: [] }, errors: {} });
      expect(out.result.sampledAt).toBe(1_200_000);
    });

    it('rejects a result whose probes/errors are not plain objects, or whose error text is not a string', async () => {
      for (const bad of [
        { sampledAt: 1_100_000, probes: [], errors: {} },
        { sampledAt: 1_100_000, probes: { prs: [] }, errors: 'x' },
        { sampledAt: '1100000', probes: {}, errors: {} },
        [],
        null,
      ]) {
        const out = await consumeRaw(bad);
        expect(out.result).toBeNull();
        expect(out.failure).toMatch(/invalid|unreadable/);
      }
      const out = await consumeRaw({ sampledAt: 1_100_000, probes: { prs: [], agents: [] }, errors: { staleState: { not: 'text' } } });
      expect(out.result.errors).toEqual({});
    });

    it('rejects a prs/agents value that is not a list (a forged `true` would otherwise stamp the cadence)', async () => {
      for (const probes of [{ prs: true, agents: true }, { prs: [], agents: 'x' }, { prs: {}, agents: [] }]) {
        const out = await consumeRaw({ sampledAt: 1_100_000, probes, errors: {} });
        expect(out.result).toBeNull();
        expect(out.failure).toMatch(/invalid/);
      }
    });

    it('never opens a FIFO or a device in the sidecar\'s place: it is not a regular file, and nothing blocks', async () => {
      const fifo = await consumeRaw((p) => execFileSync('mkfifo', [p]));
      expect(fifo.result).toBeNull();
      expect(fifo.failure).toMatch(/not a regular file/);
      const dev = await consumeRaw((p) => symlinkSync('/dev/zero', p));
      expect(dev.result).toBeNull();
      expect(dev.failure).toMatch(/not a regular file/);
    });

    it('refuses to parse a sidecar over the size cap', async () => {
      const out = await consumeRaw({ sampledAt: 1_100_000, probes: { prs: ['x'.repeat(500)], agents: [] }, errors: {} }, { maxResultBytes: 100 });
      expect(out.result).toBeNull();
      expect(out.failure).toMatch(/too large/);
    });
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

  it('a tampered sidecar with a far-future sampledAt is a probe error and never parks the gh cadence', async () => {
    const { flags, hd } = setup('future');
    const store = createJobStore(join(dir, 'jobs'));
    const deps = { collectGh: neverInline, ghJobs: { store, codeSha: 'abc123', reattach: fakeReattach(), evict: noEvict } };
    const t0 = Date.parse('2026-10-09T12:00:00Z');
    const first = await tick({ ...flags, now: iso(t0) }, deps);
    finish(store, first.ghJob.enqueued, { at: t0 + 1e11, probes: { prs: [], agents: [] } });
    const second = await tick({ ...flags, now: iso(t0 + 600_000) }, deps);
    expect(second.ghSampled).toBe(false);
    expect(second.probeErrors.ghJob).toMatch(/future/);
    expect(JSON.parse(readFileSync(join(hd, 'state.json'), 'utf8')).ghCache.at).toBeNull();
    // The cadence is still due, so a fresh job is queued rather than waiting out the forged timestamp.
    expect(second.ghJob.enqueued).toBeTruthy();
  }, 30000);

  it('cadenceDue: a missing, non-numeric, future or elapsed stamp is due; only a recent one waits', () => {
    const now = 10_000_000;
    for (const at of [undefined, null, 0, 'later', NaN, now + 1, now + 1e11, now - GH_CADENCE_MS]) expect(cadenceDue(at, now)).toBe(true);
    expect(cadenceDue(now - GH_CADENCE_MS + 1, now)).toBe(false);
    expect(cadenceDue(now, now)).toBe(false);
  });

  it('a corrupt ghCache in state.json (a string, or a non-numeric at) does not crash the tick or park the cadence', async () => {
    for (const [i, ghCache] of ['oops', 42, { at: 'later' }].entries()) {
      const { flags, hd } = setup(`corrupt-${i}`);
      const store = createJobStore(join(dir, `jobs-corrupt-${i}`));
      const deps = { collectGh: neverInline, ghJobs: { store, codeSha: 'abc123', reattach: fakeReattach(), evict: noEvict } };
      writeFileSync(join(hd, 'state.json'), JSON.stringify({ ghCache }));
      const out = await tick({ ...flags, now: iso(Date.parse('2026-10-09T12:00:00Z')) }, deps);
      expect(out.ghJob.enqueued).toBeTruthy();
    }
  }, 60000);

  it('a ghCache.at already ahead of now (clock stepped back, or a forged state) reads as due, not parked', async () => {
    const { flags, hd } = setup('stale-future');
    const store = createJobStore(join(dir, 'jobs'));
    const deps = { collectGh: neverInline, ghJobs: { store, codeSha: 'abc123', reattach: fakeReattach(), evict: noEvict } };
    const t0 = Date.parse('2026-10-09T12:00:00Z');
    const sp = join(hd, 'state.json');
    writeFileSync(sp, JSON.stringify({ ghCache: { at: t0 + 1e11 } }));
    const next = await tick({ ...flags, now: iso(t0) }, deps);
    expect(next.ghJob.enqueued).toBeTruthy(); // due, not waiting out a 1e11 ms offset
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

  it('preserves probe-error streaks across queued ticks and opens an alert after repeated failed samples', async () => {
    // Inline, a failing prs read keeps the cadence due and is retried (and re-supplied) every tick, so its streak
    // grows. As a job the failure arrives on alternate ticks: the ticks between (queued/running) sample nothing and
    // must not clear the streak the core keeps for a probe that supplied neither a sample nor an error.
    const { flags, hd } = setup('streak');
    const store = createJobStore(join(dir, 'jobs-streak'));
    const deps = { collectGh: neverInline, ghJobs: { store, codeSha: 'abc123', reattach: fakeReattach(), evict: noEvict } };
    const streak = () => JSON.parse(readFileSync(join(hd, 'state.json'), 'utf8')).probeErrors?.prs?.count;
    const t0 = Date.parse('2026-10-09T12:00:00Z');
    const failedSample = { probes: { agents: [] }, errors: { prs: 'gh: HTTP 502' } };

    const q1 = await tick({ ...flags, now: iso(t0) }, deps); // queues job 1
    finish(store, q1.ghJob.enqueued, { at: t0 + 60_000, ...failedSample });
    const c1 = await tick({ ...flags, now: iso(t0 + 120_000) }, deps); // consumes the failure
    expect(c1.probeErrors.prs).toMatch(/502/);
    expect(streak()).toBe(1);

    const q2 = await tick({ ...flags, now: iso(t0 + 180_000) }, deps); // cadence still due: queues job 2, samples nothing
    expect(q2.ghJob.enqueued).toBeTruthy();
    expect(q2.probeErrors.prs).toBeUndefined();
    expect(streak()).toBe(1); // the unsampled tick neither clears nor grows it
    const r2 = await tick({ ...flags, now: iso(t0 + 240_000) }, deps); // job 2 still running
    expect(r2.ghJob.inFlight.id).toBe(q2.ghJob.enqueued);
    expect(streak()).toBe(1);

    finish(store, q2.ghJob.enqueued, { at: t0 + 250_000, ...failedSample });
    await tick({ ...flags, now: iso(t0 + 300_000) }, deps); // consumes the second failed sample
    expect(streak()).toBe(2);

    // The third failed sample reaches the alert threshold: the health-tick-overrun smell opens its episode.
    const q3 = await tick({ ...flags, now: iso(t0 + 360_000) }, deps);
    finish(store, q3.ghJob.enqueued, { at: t0 + 370_000, ...failedSample });
    await tick({ ...flags, now: iso(t0 + 420_000) }, deps);
    expect(streak()).toBe(3);
    const episodes = JSON.parse(readFileSync(join(hd, 'state.json'), 'utf8')).episodes;
    expect(Object.keys(episodes).some((k) => k.includes('health-tick-overrun'))).toBe(true);

    // Queued/running ticks AFTER the threshold must not close the alert either: the episode closes after two clean
    // evaluations, so a streak cleared by an unsampled tick would close it while prs is still failing.
    const episodeStatus = () => Object.values(JSON.parse(readFileSync(join(hd, 'state.json'), 'utf8')).episodes)
      .find((e) => e.smell === 'health-tick-overrun')?.status;
    const q4 = await tick({ ...flags, now: iso(t0 + 480_000) }, deps); // queues job 4, samples nothing
    await tick({ ...flags, now: iso(t0 + 540_000) }, deps); // job 4 running
    await tick({ ...flags, now: iso(t0 + 600_000) }, deps); // job 4 still running
    expect(streak()).toBe(3);
    expect(episodeStatus()).toBe('open');

    // A successful sample of prs ends the streak, as it does inline.
    finish(store, q4.ghJob.enqueued, { at: t0 + 610_000, probes: { prs: [], agents: [] }, errors: {} });
    await tick({ ...flags, now: iso(t0 + 660_000) }, deps);
    expect(streak()).toBeUndefined();
  }, 60000);

  it('the carried gh-group names are exactly the probe names collectGhProbes can report an error under', () => {
    // A ninth probe added to the group without its name here would silently lose streak-holding on queued ticks.
    const used = [...collectGhProbes.toString().matchAll(/attempt\('([A-Za-z]+)'/g)].map((m) => m[1]);
    expect([...GH_GROUP_PROBE_NAMES].sort()).toEqual([...new Set(used)].sort());
  });

  it('a job that keeps failing builds its own ghJob streak across the queued ticks between failures', async () => {
    const { flags, hd } = setup('jobstreak');
    const store = createJobStore(join(dir, 'jobs-jobstreak'));
    const deps = { collectGh: neverInline, ghJobs: { store, codeSha: 'abc123', reattach: fakeReattach(), evict: noEvict } };
    const streak = () => JSON.parse(readFileSync(join(hd, 'state.json'), 'utf8')).probeErrors?.ghJob?.count;
    const t0 = Date.parse('2026-10-09T12:00:00Z');
    const q1 = await tick({ ...flags, now: iso(t0) }, deps);
    store.update(q1.ghJob.enqueued, (r) => markFailed(r, { at: iso(t0 + 1000), reason: 'handle dead; 3/3 attempts used' }));
    const f1 = await tick({ ...flags, now: iso(t0 + 60_000) }, deps); // consumes the failure, queues job 2
    expect(f1.probeErrors.ghJob).toMatch(/3\/3 attempts used/);
    expect(streak()).toBe(1);
    const mid = await tick({ ...flags, now: iso(t0 + 120_000) }, deps); // job 2 running: nothing consumed
    expect(mid.probeErrors.ghJob).toBeUndefined();
    expect(streak()).toBe(1);
    store.update(f1.ghJob.enqueued, (r) => markFailed(r, { at: iso(t0 + 130_000), reason: 'handle dead; 3/3 attempts used' }));
    await tick({ ...flags, now: iso(t0 + 180_000) }, deps);
    expect(streak()).toBe(2);
  }, 60000);

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

  it('retries budget-deferred diagnoses on the next tick, without another episode transition', async () => {
    const smell = {
      id: 'fake-retry', probes: ['machineLoad'], severity: 'medium', openAfter: 1, diagnose: { command: 'node', args: ['-e', 'retry'] },
      evaluate: () => ['a', 'b'].map((x) => ({ subject: x, breach: true, measure: {}, summary: `s ${x}`, recommendation: 'r' })),
    };
    const { flags } = setup('diag-retry', { ghProbes: false });
    const base = { ...flags, 'no-gh': true, 'no-diagnose': false };
    const calls = [];
    const runDiagnosis = (c, a) => { calls.push(a.join(' ')); return 'ok'; };
    // Tick 1: the budget is already spent, so the episodes open undiagnosed and the deferral is remembered.
    const first = await tick({ ...base, now: '2026-10-09T12:00:00Z' }, { smells: [smell], runDiagnosis, clock: () => Date.now() + 10 * 60_000 });
    expect(calls).toHaveLength(0);
    expect(first.probeErrors.diagnoseDeferred).toMatch(/^2 diagnosis\(es\)/);
    // Tick 2: nothing transitions (both episodes stay open), yet the deferred diagnosis runs once and is recorded.
    const second = await tick({ ...base, now: '2026-10-09T12:05:00Z' }, { smells: [smell], runDiagnosis });
    expect(calls).toEqual(['-e retry']);
    expect(second.diagnoses.map((d) => d.key).sort()).toHaveLength(2);
    expect(second.probeErrors.diagnoseDeferred).toBeUndefined();
    // Tick 3: the deferral is cleared, so it is not asked for again.
    await tick({ ...base, now: '2026-10-09T12:10:00Z' }, { smells: [smell], runDiagnosis });
    expect(calls).toEqual(['-e retry']);
  }, 30000);
});

describe('runGhProbeJobs — a cold snapshot is never built inside the tick', () => {
  /** A snapshot whose build is counted: `materialize` is the code snapshot, `install` the node_modules store. */
  function countingSnapshot() {
    const calls = { materialize: 0, install: 0 };
    return {
      calls,
      snapshot: {
        materialize: (into) => { calls.materialize += 1; writeFileSync(join(into, 'package.json'), '{}'); writeFileSync(join(into, 'package-lock.json'), '{"lock":1}'); },
        install: (into) => { calls.install += 1; mkdirSync(join(into, 'node_modules')); },
      },
    };
  }
  const run = (store, snapshot, extra, over = {}) => runGhProbeJobs({
    store, codeSha: 'abc123', evict: () => ({ evicted: [] }), input: { sourceRoot: dir }, snapshot, ...extra, ...over,
  });

  it('leaves the job queued with no attempt spent and asks for a prewarm; once warm, the next tick launches it', async () => {
    const store = createJobStore(join(dir, 'jobs'));
    const { calls, snapshot } = countingSnapshot();
    const prewarms = [];
    const launched = [];
    const warmGate = {
      requestPrewarm: (o) => { prewarms.push(o.codeSha); return { state: 'started' }; },
      launchFn: ({ id }) => { launched.push(id); return store.read(id); },
    };
    const a = await run(store, snapshot, { now: 1_000_000, due: true, warmGate });
    expect(calls).toEqual({ materialize: 0, install: 0 }); // nothing was built inside the tick
    expect(prewarms).toEqual(['abc123']);
    const rec = store.read(a.summary.enqueued);
    expect(rec.job.status).toBe('queued');
    expect(rec.job.attempts).toBe(0);
    expect(launched).toEqual([]);
    expect(a.summary.warming).toEqual([{ id: a.summary.enqueued, codeSha: 'abc123', state: 'started' }]);

    prewarmSnapshots({ jobsDir: store.dir, codeSha: 'abc123', snapshot }); // the prewarm child's work, off the tick
    expect(calls).toEqual({ materialize: 1, install: 1 });
    const b = await run(store, snapshot, { now: 1_060_000, due: true, state: a.state, warmGate });
    expect(launched).toEqual([a.summary.enqueued]);
    expect(prewarms).toEqual(['abc123']); // warm: no second request
    expect(b.summary.warming).toEqual([]);
    expect(calls).toEqual({ materialize: 1, install: 1 }); // and the tick still built nothing
  });

  it('a requeued job (dead handle, retry) is gated the same way: it waits queued while its store is cold', async () => {
    const store = createJobStore(join(dir, 'jobs'));
    const { calls, snapshot } = countingSnapshot();
    const launched = [];
    const warmGate = { requestPrewarm: () => ({ state: 'warming' }), launchFn: ({ id }) => { launched.push(id); return store.read(id); } };
    const a = await run(store, snapshot, { now: 1_000_000, due: true, warmGate });
    // the job was launched once before, died, and is back in the queue with its retry due
    store.update(a.summary.enqueued, (r) => markLaunching(r, { at: iso(1_000_500) }));
    store.update(a.summary.enqueued, (r) => markClaimed(r, { at: iso(1_000_600), handle: 'h:1:x', host: 'h', pid: 1, procStart: 'x' }));
    store.update(a.summary.enqueued, (r) => markRequeued(r, { at: iso(1_100_000), now: 1_100_000, reason: 'handle dead', resume: false, backoffBaseMs: 1 }));
    const b = await run(store, snapshot, { now: 1_200_000, due: false, state: a.state, warmGate });
    expect(launched).toEqual([]);
    expect(calls).toEqual({ materialize: 0, install: 0 });
    expect(b.summary.warming.map((w) => w.state)).toEqual(['warming']);
  });

  it('the drain (rollback) path builds nothing and starts no build: a cold queued job fails visibly', async () => {
    const store = createJobStore(join(dir, 'jobs'));
    const { calls, snapshot } = countingSnapshot();
    const asked = [];
    const warmGate = { requestPrewarm: (o) => { asked.push(o.codeSha); return { state: 'started' }; }, launchFn: () => { throw new Error('must not launch cold'); } };
    const a = await run(store, snapshot, { now: 1_000_000, due: true, warmGate });
    const b = await run(store, snapshot, { now: 1_100_000, due: false, drain: true, state: a.state, warmGate });
    expect(calls).toEqual({ materialize: 0, install: 0 });
    expect(asked).toEqual(['abc123']); // only the normal tick asked; the drain pass did not
    expect(store.read(a.summary.enqueued).job.status).toBe('failed');
    expect(store.read(a.summary.enqueued).job.error).toMatch(/rollback with a cold snapshot/);
    expect(b.summary.warming).toEqual([{ id: a.summary.enqueued, codeSha: 'abc123', state: 'failed', error: 'rollback' }]);
  });

  it('a request that throws (marker unwritable) leaves the job queued with a visible state instead of aborting the pass', async () => {
    const store = createJobStore(join(dir, 'jobs'));
    const { snapshot } = countingSnapshot();
    const warmGate = { requestPrewarm: () => { throw new Error('ENOSPC: no space left'); }, launchFn: () => { throw new Error('no'); } };
    const a = await run(store, snapshot, { now: 1_000_000, due: true, warmGate });
    expect(store.read(a.summary.enqueued).job.status).toBe('queued');
    expect(a.summary.warming[0]).toMatchObject({ state: 'backoff', error: expect.stringMatching(/prewarm request failed: ENOSPC/) });
  });

  it('a job whose codeSha is not a safe key fails visibly and never reaches a file name or a CLI argument', async () => {
    const store = createJobStore(join(dir, 'jobs'));
    const { snapshot } = countingSnapshot();
    const asked = [];
    const warmGate = { requestPrewarm: (o) => { asked.push(o); return { state: 'started' }; }, launchFn: () => { throw new Error('no'); } };
    const a = await run(store, snapshot, { now: 1_000_000, due: true, warmGate, codeSha: '../../etc/x' });
    expect(asked).toEqual([]);
    expect(store.read(a.summary.enqueued).job.status).toBe('failed');
    expect(store.read(a.summary.enqueued).job.error).toMatch(/no valid codeSha/);
    for (const bad of ['', 'a/b', '..', '../x', 'a..b', '-x', 'x y', 'x\ny', 'x'.repeat(129), null, 42]) expect(isSafeCodeSha(bad)).toBe(false);
    for (const ok of ['abc123', 'a'.repeat(40), 'test-snapshot', 'v1.2_3']) expect(isSafeCodeSha(ok)).toBe(true);
  });

  it('a prewarm that keeps failing fails the queued job visibly instead of leaving it queued forever', async () => {
    const store = createJobStore(join(dir, 'jobs'));
    const { snapshot } = countingSnapshot();
    const warmGate = { requestPrewarm: () => ({ state: 'failed', error: 'npm ci exploded', attempts: 3 }), launchFn: () => { throw new Error('no'); } };
    const a = await run(store, snapshot, { now: 1_000_000, due: true, warmGate });
    const rec = store.read(a.summary.enqueued);
    expect(rec.job.status).toBe('failed');
    expect(rec.job.error).toMatch(/could not prepare code: prewarm failed after 3 attempt\(s\): npm ci exploded/);
    const b = await run(store, snapshot, { now: 1_060_000, due: false, state: a.state, warmGate });
    expect(b.failure).toMatch(/failed: could not prepare code: prewarm failed.*npm ci exploded/); // surfaces as a probe error, once
  });

  it('a non-readonly or already-launching record is passed straight to the real launch', () => {
    const store = createJobStore(join(dir, 'jobs'));
    const seen = [];
    const gate = createWarmGate({ jobsDir: store.dir, sourceRoot: dir, launchFn: (o) => { seen.push(o.id); return null; }, isWarm: () => { throw new Error('not consulted'); } });
    expect(gate.launch({ store, id: 'missing', kindDef: undefined })).toBeNull();
    expect(seen).toEqual(['missing']);
  });
});

describe('requestPrewarm — single flight, backoff and a visible give-up', () => {
  const sha = 'abc123';
  const mk = () => { const jobsDir = join(dir, 'jobs'); mkdirSync(jobsDir, { recursive: true }); return jobsDir; };
  const spawnCalls = (n) => { const spawns = []; return { spawns, spawnFn: () => { spawns.push(n + spawns.length); return 4242; } }; };

  it('starts one build, and a second request while it is alive and young spawns nothing', () => {
    const jobsDir = mk();
    const { spawns, spawnFn } = spawnCalls(0);
    expect(requestPrewarm({ jobsDir, codeSha: sha, sourceRoot: dir, now: 1000, spawnFn, pidAlive: () => true })).toEqual({ state: 'started', attempts: 1 });
    expect(requestPrewarm({ jobsDir, codeSha: sha, sourceRoot: dir, now: 61_000, spawnFn, pidAlive: () => true }).state).toBe('warming');
    expect(spawns).toHaveLength(1);
  });

  it('a build whose pid is gone, or that outlived the max age, is a failed attempt: backoff, then one retry', () => {
    const jobsDir = mk();
    const { spawns, spawnFn } = spawnCalls(0);
    requestPrewarm({ jobsDir, codeSha: sha, sourceRoot: dir, now: 1000, spawnFn, pidAlive: () => true });
    const dead = requestPrewarm({ jobsDir, codeSha: sha, sourceRoot: dir, now: 2000, spawnFn, pidAlive: () => false });
    expect(dead).toMatchObject({ state: 'backoff', attempts: 1 }); // died at once: waits out the first backoff
    const retry = requestPrewarm({ jobsDir, codeSha: sha, sourceRoot: dir, now: 2000 + PREWARM_BACKOFF_BASE_MS, spawnFn, pidAlive: () => true });
    expect(retry).toEqual({ state: 'started', attempts: 2 });
    const old = requestPrewarm({ jobsDir, codeSha: sha, sourceRoot: dir, now: 2000 + PREWARM_BACKOFF_BASE_MS + PREWARM_MAX_MS + 1, spawnFn, pidAlive: () => true });
    expect(old.state).toBe('backoff'); // alive pid but far too old (pid reuse / hung): also a failure
    expect(spawns).toHaveLength(2);
  });

  it('gives up after the max attempts, holds the failure, then resets for a fresh round', () => {
    const jobsDir = mk();
    const { spawns, spawnFn } = spawnCalls(0);
    let t = 0;
    for (let i = 0; i < PREWARM_MAX_ATTEMPTS; i += 1) {
      t += PREWARM_BACKOFF_BASE_MS * 2 ** i + 1;
      expect(requestPrewarm({ jobsDir, codeSha: sha, sourceRoot: dir, now: t, spawnFn, pidAlive: () => true }).state).toBe('started');
      prewarmMain({ jobsDir, codeSha: sha, sourceRoot: dir, now: () => t, snapshot: { materialize: () => { throw new Error('npm ci exploded\nstack…'); } } });
    }
    const gaveUp = requestPrewarm({ jobsDir, codeSha: sha, sourceRoot: dir, now: t + 1, spawnFn, pidAlive: () => true });
    expect(gaveUp).toEqual({ state: 'failed', error: 'npm ci exploded', attempts: PREWARM_MAX_ATTEMPTS });
    expect(spawns).toHaveLength(PREWARM_MAX_ATTEMPTS);
    const reset = requestPrewarm({ jobsDir, codeSha: sha, sourceRoot: dir, now: t + PREWARM_FAILED_HOLD_MS + 1, spawnFn, pidAlive: () => true });
    expect(reset).toEqual({ state: 'started', attempts: 1 });
  });

  it('writes the single-flight marker BEFORE spawning, and patches the pid in without clobbering a child that already finished', () => {
    const jobsDir = mk();
    const markerPath = join(jobsDir, '.prewarm', `${sha}.json`);
    let seenAtSpawn = null;
    const r = requestPrewarm({ jobsDir, codeSha: sha, sourceRoot: dir, now: 1000, pidAlive: () => true,
      spawnFn: () => { seenAtSpawn = JSON.parse(readFileSync(markerPath, 'utf8')); return 4242; } });
    expect(r.state).toBe('started');
    expect(seenAtSpawn).toMatchObject({ status: 'running', pid: null, attempts: 1 }); // already on disk when the child starts
    expect(JSON.parse(readFileSync(markerPath, 'utf8'))).toMatchObject({ status: 'running', pid: 4242 });
    // a child that fails fast: its failure survives the parent's pid patch
    rmSync(markerPath);
    requestPrewarm({ jobsDir, codeSha: sha, sourceRoot: dir, now: 5000, pidAlive: () => true,
      spawnFn: () => { prewarmMain({ jobsDir, codeSha: sha, sourceRoot: dir, now: () => 5001, snapshot: { materialize: () => { throw new Error('boom'); } } }); return 4243; } });
    expect(JSON.parse(readFileSync(markerPath, 'utf8'))).toMatchObject({ status: 'failed', error: 'boom' });
  });

  it('a spawn that throws records a failed attempt (backoff), not an unbounded respawn; an unwritable marker spawns nothing', () => {
    const jobsDir = mk();
    const out = requestPrewarm({ jobsDir, codeSha: sha, sourceRoot: dir, now: 1000, spawnFn: () => { throw new Error('spawn EAGAIN'); } });
    expect(out).toMatchObject({ state: 'backoff', attempts: 1, error: expect.stringMatching(/could not start the prewarm build: spawn EAGAIN/) });
    expect(requestPrewarm({ jobsDir, codeSha: sha, sourceRoot: dir, now: 2000, spawnFn: () => { throw new Error('must not spawn'); } }).state).toBe('backoff');
    const blocked = join(dir, 'blocked-jobs'); mkdirSync(blocked); writeFileSync(join(blocked, '.prewarm'), 'a file, not a dir');
    let spawned = 0;
    expect(() => requestPrewarm({ jobsDir: blocked, codeSha: sha, sourceRoot: dir, now: 1, spawnFn: () => { spawned += 1; return 1; } })).toThrow();
    expect(spawned).toBe(0);
  });

  it('a corrupt marker, a bad pid, or a bad sha is never trusted', () => {
    const jobsDir = mk();
    mkdirSync(join(jobsDir, '.prewarm'), { recursive: true });
    const write = (body) => writeFileSync(join(jobsDir, '.prewarm', `${sha}.json`), typeof body === 'string' ? body : JSON.stringify(body));
    const { spawns, spawnFn } = spawnCalls(0);
    write('{not json');
    expect(requestPrewarm({ jobsDir, codeSha: sha, sourceRoot: dir, now: 1000, spawnFn }).state).toBe('started');
    write({ status: 'running', pid: 0, startedAt: 1000, attempts: 1 }); // pid 0 would make kill(0,0) look alive
    expect(requestPrewarm({ jobsDir, codeSha: sha, sourceRoot: dir, now: 1001, spawnFn }).state).toBe('started');
    expect(spawns).toHaveLength(2);
    expect(requestPrewarm({ jobsDir, codeSha: '../x', sourceRoot: dir, now: 1, spawnFn })).toMatchObject({ state: 'failed', attempts: 0 });
    expect(prewarmMain({ jobsDir, codeSha: '../x', sourceRoot: dir, snapshot: {} })).toBe(2);
    expect(spawns).toHaveLength(2);
  });

  it('the prewarm child builds the snapshot, clears its marker, and is idempotent; snapshotWarm tells cold from warm without building', () => {
    const jobsDir = mk();
    let built = 0;
    const snapshot = {
      materialize: (into) => { built += 1; writeFileSync(join(into, 'package.json'), '{}'); writeFileSync(join(into, 'package-lock.json'), '{"l":2}'); },
      install: (into) => mkdirSync(join(into, 'node_modules')),
    };
    expect(snapshotWarm({ jobsDir, codeSha: sha })).toBe(false);
    expect(built).toBe(0); // asking never builds
    requestPrewarm({ jobsDir, codeSha: sha, sourceRoot: dir, now: 1, spawnFn: () => 1, pidAlive: () => true });
    expect(prewarmMain({ jobsDir, codeSha: sha, sourceRoot: dir, snapshot })).toBe(0);
    expect(existsSync(join(jobsDir, '.prewarm', `${sha}.json`))).toBe(false);
    expect(snapshotWarm({ jobsDir, codeSha: sha })).toBe(true);
    expect(snapshotWarm({ jobsDir, codeSha: sha, nodeModules: false })).toBe(true);
    expect(prewarmMain({ jobsDir, codeSha: sha, sourceRoot: dir, snapshot })).toBe(0);
    expect(built).toBe(1);
    expect(snapshotWarm({ jobsDir, codeSha: '../escape' })).toBe(false); // an invalid sha is never "warm"
  });
});

describe('evictToTrash — the tick renames, a detached child deletes', () => {
  it('moves unreferenced snapshot trees out of the live names atomically without deleting them in the tick; sweepTrash then deletes', () => {
    const jobsDir = join(dir, 'jobs'); const snaps = join(jobsDir, '.snapshots');
    const mkStore = (sub, name, ageSec) => {
      const d = join(snaps,sub, name); mkdirSync(join(d, 'deep'), { recursive: true }); writeFileSync(join(d, 'deep', 'f'), 'x'); writeFileSync(join(d, '.snapshot-complete'), '');
      const t = new Date(Date.now() - ageSec * 1000); utimesSync(d, t, t);
    };
    for (const [n, age] of [['s1', 400], ['s2', 300], ['s3', 200], ['s4', 100]]) mkStore('code', n, age);
    mkStore('node-modules', 'k1', 50);
    let swept = 0;
    const out = evictToTrash({ jobsDir, referenced: ['code:s1'], spawnSweep: () => { swept += 1; }, now: () => 7 });
    expect(out.evicted.length).toBeGreaterThan(0);
    expect(out.evicted.every((r) => r.startsWith('code:'))).toBe(true);
    expect(existsSync(join(snaps,'code', 's1'))).toBe(true); // referenced: kept
    const gone = out.evicted.map((r) => r.slice(5));
    for (const n of gone) {
      expect(existsSync(join(snaps,'code', n))).toBe(false); // the live name is free…
      expect(existsSync(join(snaps,'.trash', `code-${n}.7`, 'deep', 'f'))).toBe(true); // …but nothing was deleted in the tick
    }
    expect(swept).toBe(1);
    expect(sweepTrash({ jobsDir })).toBe(gone.length);
    expect(readdirSync(join(snaps,'.trash'))).toEqual([]);
    expect(evictToTrash({ jobsDir, referenced: [], spawnSweep: () => { throw new Error('nothing moved, nothing to sweep'); } }).evicted.length).toBeGreaterThanOrEqual(0);
  });
});
