/** @file scripts/lib/__tests__/daemon-rebuild-early-launch.test.mjs — Node policy, IO and scheduling regressions. */
import { test as nodeTest } from 'node:test';
// Also register with the repository runner when this node:test suite is selected by Vitest.
const test = process.env.VITEST ? (await import('vitest')).test : nodeTest;
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, appendFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendDaemonEvent } from '../daemon-events.mjs';
import { decideEarlyLaunch } from '../daemon-rebuild-early-launch.mjs';
import { createEarlyLaunchWatcher, createMainMoveReader, resolveEarlyLaunch } from '../daemon-rebuild-early-watch.mjs';
import { buildRebuildJobResult, rebuildCloneAsJob } from '../daemon-rebuild/rebuild-job.mjs';
import { finalizeRebuild } from '../daemon-rebuild/adopt.mjs';
import { readRebuildState } from '../daemon-rebuild/state.mjs';
import { createJobStore } from '../daemon-jobs-runtime.mjs';
import { probeEarlyRebuild } from '../../conveyor/soak/fixtures/early-rebuild-probe.mjs';

function fixture(options = {}) {
  let clock = 0, signal = null, busy = false;
  const launches = [];
  const w = createEarlyLaunchWatcher({ settings: { enabled: true, debounceMs: 60 }, now: () => clock,
    readSignal: () => { const s = signal; signal = null; return s; }, inFlight: () => busy,
    launch: async (o) => { launches.push(o); }, schedule: () => ({ unref() {} }), ...options });
  return { w, launches, at: (n) => { clock = n; }, signal: (n) => { signal = clock = n; }, busy: (b) => { busy = b; } };
}

test('main-push burst launches exactly once after the LAST signal debounce window', async () => {
  const f = fixture();
  f.signal(100); await f.w.poll();
  f.signal(140); await f.w.poll();
  f.at(199); await f.w.poll(); assert.equal(f.launches.length, 0);
  f.at(200); await f.w.poll(); await f.w.poll(); assert.equal(f.launches.length, 1);
  f.signal(201); await f.w.poll(); f.at(260); await f.w.poll(); assert.equal(f.launches.length, 1);
  f.at(261); await f.w.poll(); assert.equal(f.launches.length, 2);
});

test('no launch while a rebuild for the target is in flight; unknown state fails closed', async () => {
  const f = fixture(); f.signal(100); f.busy(true); await f.w.poll(); f.at(500); await f.w.poll();
  assert.equal(f.launches.length, 0); f.busy(null); await f.w.poll(); assert.equal(f.launches.length, 0);
  f.busy(false); await f.w.poll(); assert.equal(f.launches.length, 1);
});

test('in-flight tick wait is recorded separately and launch never overlaps a tick', async () => {
  const f = fixture(); let release;
  const gate = new Promise((r) => { release = r; });
  const tick = f.w.tick(() => gate);
  f.signal(100); await f.w.poll(); f.at(160); await f.w.poll(); assert.equal(f.launches.length, 0);
  f.at(500); release(); await tick; f.at(600); await f.w.poll();
  assert.equal(f.launches[0].waitInFlightTickMs, 340);
  assert.equal(f.launches[0].launchedBy, 'early');
  const result = buildRebuildJobResult(f.launches[0], { waitInFlightTickMs: 20, waitSmokeSlotMs: 700, readyRecorded: true }, null, 1000);
  assert.equal(result.waitInFlightTickMs, 360); assert.equal(result.waitSmokeSlotMs, 700);
  assert.equal(result.launchedBy, 'early');
});

test('tick joins an already running early launch before acquiring any tick lock', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const f = fixture({ launch: () => gate }); f.signal(100); await f.w.poll(); f.at(160);
  const poll = f.w.poll(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  let ticked = false; const tick = f.w.tick(() => { ticked = true; });
  await Promise.resolve(); assert.equal(ticked, false); release(); await poll; await tick; assert.equal(ticked, true);
});

test('unknown signals, disabled mode and invalid bounds refuse; tick-start remains the fallback', async () => {
  for (const patch of [{ enabled: false }, { mainMovedAtMs: null }, { jobInFlightForTarget: null }, { debounceMs: NaN }, { lastLaunchAtMs: NaN }]) {
    assert.equal(decideEarlyLaunch({ enabled: true, mainMovedAtMs: 100, lastLaunchAtMs: null, jobInFlightForTarget: false, nowMs: 1000, debounceMs: 60, ...patch }).launch, false);
  }
  const r = await probeEarlyRebuild(undefined, false);
  assert.equal(r.ticks, 1); assert.equal(r.tickStart.held, false); assert.equal(r.launches.length, 0);
});

test('watcher launches through withSelfSync before the next tick', async () => {
  const r = await probeEarlyRebuild(); assert.equal(r.launches.length, 1);
  assert.equal(r.launches[0].launchOnly, true); assert.equal(r.launches[0].ticks, 1); assert.equal(r.launches[0].held, false);
});

test('launch exceptions and unreadable signals never escape the watcher', async () => {
  const f = fixture({ launch: () => { throw new Error('unavailable'); }, log: () => { throw new Error('log unavailable'); } });
  f.signal(100); await f.w.poll(); f.at(200); await assert.doesNotReject(f.w.poll());
  const g = fixture({ readSignal: () => { throw new Error('unreadable'); } }); await assert.doesNotReject(g.w.poll());
});

test('pr-merged event reader skips history, retains partial lines, filters repos and bounds backlog', () => {
  const dir = mkdtempSync(join(tmpdir(), 'early-events-'));
  try {
    const path = join(dir, 'events.jsonl');
    const event = JSON.stringify({ kind: 'pr-merged', repo: 'web-everything' });
    writeFileSync(path, event + '\n'); let now = 100;
    const read = createMainMoveReader({ path, now: () => now }); assert.equal(read(), null);
    appendFileSync(path, event); assert.equal(read(), null);
    appendFileSync(path, '\n'); assert.equal(read(), 100); assert.equal(read(), null);
    appendFileSync(path, JSON.stringify({ kind: 'pr-merged', repo: 'frontierui' }) + '\n'); assert.equal(read(), null);
    appendFileSync(path, 'x'.repeat(256 * 1024 + 1)); assert.throws(read, /backlog/); assert.equal(read(), null);
    appendFileSync(path, '{bad}\n'); assert.throws(read);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('entry opt-in supports health-watch and environment rollback wins', () => {
  const tool = { enabled: false, entries: ['health-watch.mjs'], debounceMs: 99 };
  assert.equal(resolveEarlyLaunch({ tool, env: {}, entries: ['scripts/health-watch.mjs'] }).enabled, true);
  assert.equal(resolveEarlyLaunch({ tool, env: { WE_DAEMON_REBUILD_EARLY_LAUNCH: '0' }, entries: ['health-watch.mjs'] }).enabled, false);
  assert.equal(resolveEarlyLaunch({ tool, env: {}, entries: ['review-daemon.mjs'] }).enabled, false);
});

test('early and tick-start use the same job queue; early never calls adoption; existing job suppresses launch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'early-jobs-'));
  try {
    const store = createJobStore(join(dir, 'jobs')); let adopts = 0;
    const base = { root: dir, env: {}, store, codeSha: 'a'.repeat(40), snapshot: {}, now: () => 1000,
      reattach: async () => {}, evict: () => {}, log: { error() {} }, settings: { minIntervalMs: 0, minIntervalJitterPct: 0 },
      adopt: async () => { adopts += 1; return { reason: 'needs-build', plan: { finalSha: 'target' } }; } };
    const early = await rebuildCloneAsJob({ ...base, launchOnly: true, launchedBy: 'early', waitInFlightTickMs: 40 });
    assert.equal(early.reason, 'rebuild-job-started'); assert.equal(adopts, 0);
    const input = store.list().records[0].input;
    assert.equal(input.launchedBy, 'early'); assert.equal(input.waitInFlightTickMs, 40);
    const second = await rebuildCloneAsJob({ ...base, launchOnly: true, launchedBy: 'early' });
    assert.equal(second.reason, 'rebuild-job-running'); assert.equal(store.list().records.length, 1);
    const fallback = await rebuildCloneAsJob({ ...base, store: createJobStore(join(dir, 'fallback')) });
    assert.equal(fallback.reason, 'rebuild-job-started'); assert.equal(adopts, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test('ready-to-adopted duration is persisted on the adopted status record', async () => {
  const root = mkdtempSync(join(tmpdir(), 'early-adopt-'));
  const sha = 'a'.repeat(40);
  const env = { WE_DAEMON_STATE_DIR: join(root, 'state'), WE_DAEMON_OVERLAY_DIR: join(root, 'overlays') };
  try {
    // Already-at-target branch exercises the real state writer without mutating a checkout.
    const r = await finalizeRebuild({ root, env, log: { error() {} }, now: () => 1000,
      readyPassedAt: new Date(400).toISOString(), prevHead: 'previous', lease: {},
      plan: { finalSha: sha, mainSha: sha, inputsKey: 'inputs', applied: [] },
      run: (args) => ({ status: 0, stdout: args[0] === 'rev-parse' ? sha : '', stderr: '' }) });
    assert.equal(r.adopted, true);
    assert.equal(readRebuildState(root, env).adopted.readyToAdoptedMs, 600);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('real pr-merged producer using the repository slug drives exactly one trailing launch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'early-producer-'));
  try {
    const env = { WE_DAEMON_EVENTS: join(dir, 'events.jsonl') };
    let clock = 100;
    const launches = [];
    const w = createEarlyLaunchWatcher({ settings: { enabled: true, debounceMs: 60 },
      now: () => clock, readSignal: createMainMoveReader({ env, now: () => clock }), inFlight: () => false,
      launch: (o) => { launches.push(o); }, schedule: () => ({ unref() {} }) });
    assert.equal(await appendDaemonEvent({ kind: 'pr-merged', repo: 'web-everything/web-everything', pr: 1 }, { env }), true);
    await w.poll(); clock = 140;
    await appendDaemonEvent({ kind: 'pr-merged', repo: 'web-everything/web-everything', pr: 2 }, { env });
    await w.poll(); clock = 199; await w.poll(); assert.equal(launches.length, 0);
    clock = 200; await w.poll(); await w.poll(); assert.equal(launches.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('corrupt job-store evidence blocks early queuing without adopting', async () => {
  const root = mkdtempSync(join(tmpdir(), 'early-corrupt-'));
  try {
    const store = createJobStore(join(root, 'jobs'));
    store.list = () => ({ records: [], corrupt: ['unreadable'] });
    const r = await rebuildCloneAsJob({ root, store, launchOnly: true, env: {},
      adopt: () => { throw new Error('unexpected adopt'); } });
    assert.equal(r.reason, 'rebuild-job-running'); assert.equal(r.unknownJobState, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('AS_JOB=0 prevents early launch through the declared self-sync resolver', async () => {
  const r = await probeEarlyRebuild(undefined, true, { rebuildAsJob: undefined,
    env: { WE_DAEMON_REBUILD_AS_JOB: '0', WE_DAEMON_BACKGROUND_BUILD: '1' } });
  assert.equal(r.ticks, 1);
  assert.equal(r.launches.length, 0);
  assert.ok(r.tickStart, 'the tick-start rebuild still runs');
});

test('declared inline rebuild setting prevents early launch', async () => {
  const r = await probeEarlyRebuild(undefined, true, { rebuildAsJob: false });
  assert.equal(r.ticks, 1);
  assert.equal(r.launches.length, 0);
  assert.ok(r.tickStart, 'the tick-start rebuild still runs');
});
