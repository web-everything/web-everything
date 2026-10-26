/**
 * @file scripts/lib/__tests__/daemon-jobs-runtime.test.mjs
 * @description #4125 — the job runtime on real processes and a real temp jobs folder: handle liveness via
 *   `ps` (a reused pid is refused), the child's claim / resume / supersede rules, the reattach tick (dead →
 *   requeued, stalled → stopped then requeued, 3 attempts → failed, the cap), stopping a frozen process, and
 *   one real detached launch from a pinned snapshot that finishes exactly once.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keepAliveScript, spawnKeepAlive } from '../test-keepalive.mjs';

import {
  JOB_ATTEMPT_ENV, JOB_ID_ENV, createJobStore, enqueueJob, hostName, launchJob, localHostAliases, probeHandle, readProcStart,
  reapDeadGroup, reattachTick, runJob, selfHandle, stopHandle,
} from '../daemon-jobs-runtime.mjs';
import { defineJobKind, kindRegistry, markClaimed, markLaunching, markSucceeded } from '../daemon-jobs.mjs';
import { createRecordingFacts, runItemTask, enqueueItemTask } from '../daemon-item-tasks.mjs';
import { formatJobHandle } from '../../operations/job-record.mjs';
import { runPath } from '../../operations/run-store.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNTIME = resolve(HERE, '..', 'daemon-jobs-runtime.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs = 10_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('waitFor: timed out');
    await sleep(50);
  }
}

function spawnSleeper() {
  return spawnKeepAlive();
}

const noop = defineJobKind({ kind: 'noop', entry: 'job.mjs' });
const kinds = kindRegistry([noop]);

let dir;
let store;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'we-daemon-jobs-')); store = createJobStore(dir); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('createJobStore.list — sidecar files vs torn records', () => {
  // Live case: the rebuild job keeps `consumed.json` (a JSON ARRAY of consumed job ids) in the same folder.
  // It is not a record at all, yet it was reported "corrupt — left untouched" on every daemon tick.
  it('ignores a parseable non-record .json sidecar (consumed.json array) — not corrupt, not a record', async () => {
    const rec = enqueueJob({ store, kindDef: noop, codeSha: "a".repeat(40) });
    writeFileSync(join(dir, 'consumed.json'), `${JSON.stringify([rec.id, 'job-noop-old'])}\n`);
    writeFileSync(join(dir, 'notes.json'), '{"lastSweep":"2026-10-10T00:00:00Z"}\n');
    const { records, corrupt } = store.list();
    expect(corrupt).toEqual([]);
    expect(records.map((r) => r.id)).toEqual([rec.id]);
    const logs = [];
    const out = await reattachTick({ store, kinds, maxConcurrent: 1, launch: () => null, observation: { now: Date.now(), slept: false, gapMs: 0 }, log: (m) => logs.push(m) });
    expect(out.corrupt).toEqual([]);
    expect(logs.filter((m) => m.includes('corrupt'))).toEqual([]);
  });

  it('still reports a torn job record (unparseable, or record-shaped but invalid) as corrupt and never deletes it', () => {
    const rec = enqueueJob({ store, kindDef: noop, codeSha: "a".repeat(40) });
    writeFileSync(join(dir, 'job-noop-torn.json'), '{"v":1,"id":"job-noop-tor');
    writeFileSync(join(dir, 'job-noop-empty.json'), '');
    writeFileSync(join(dir, 'job-noop-bad.json'), '{"v":1,"id":"job-noop-bad","job":"not-an-object"}');
    const { records, corrupt } = store.list();
    expect(records.map((r) => r.id)).toEqual([rec.id]);
    expect(corrupt.sort()).toEqual(['job-noop-bad', 'job-noop-empty', 'job-noop-torn']);
  });
});

describe('localHostAliases', () => {
  it('collects sanitized hostname and macOS names with bounded scutil calls, without caching injected options', () => {
    const execFn = vi.fn((command, args) => args[1] === 'LocalHostName' ? ' MacBook-Pro\n' : ' My Mac:Book\n');
    const options = { host: 'Mac:Office.example', platform: 'darwin', execFn };
    const expected = new Set(['Mac-Office.example', 'Mac-Office', 'Mac-Office.local', 'MacBook-Pro', 'MacBook-Pro.local', 'My-Mac-Book']);
    expect(localHostAliases(options)).toEqual(expected);
    expect(execFn.mock.calls).toEqual([
      ['scutil', ['--get', 'LocalHostName'], { timeout: 5_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }],
      ['scutil', ['--get', 'ComputerName'], { timeout: 5_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }],
    ]);
    expect(localHostAliases(options)).toEqual(expected);
    expect(execFn).toHaveBeenCalledTimes(4);
  });

  it('uses only hostname aliases on Linux without executing commands', () => {
    const execFn = vi.fn();
    expect(localHostAliases({ host: 'server.example', platform: 'linux', execFn })).toEqual(new Set(['server.example', 'server', 'server.local']));
    expect(execFn).not.toHaveBeenCalled();
  });

  it('skips a throwing scutil call and still collects the other name', () => {
    const execFn = vi.fn((command, args) => {
      if (args[1] === 'LocalHostName') throw new Error('unavailable');
      return 'My Mac';
    });
    expect(localHostAliases({ host: 'Mac', platform: 'darwin', execFn })).toEqual(new Set(['Mac', 'Mac.local', 'My-Mac']));
    expect(execFn).toHaveBeenCalledTimes(2);
    expect(localHostAliases({ host: 'Mac', platform: 'darwin', execFn: () => { throw new Error('unavailable'); } })).toEqual(new Set(['Mac', 'Mac.local']));
  });

  it('drops empty names rather than adding an empty short-name alias', () => {
    expect(localHostAliases({ host: '', platform: 'darwin', execFn: () => ' \n' })).toEqual(new Set());
  });
});

describe('handle liveness', () => {
  const oldHandle = 'MacBook-Pro.local:43287:Mon Oct 12 18:14:01 2026';
  const aliases = new Set(['Mac', 'MacBook-Pro', 'MacBook-Pro.local']);

  it('recognizes an old local hostname when pid and start time match', () => {
    const readStart = vi.fn(() => 'Mon Oct 12 18:14:01 2026');
    expect(probeHandle(oldHandle, { host: 'Mac', aliases, readStart })).toBe('alive');
    expect(readStart).toHaveBeenCalledWith(43287);
  });

  it('reads an old-name handle with a gone pid as dead', () => {
    expect(probeHandle(oldHandle, { host: 'Mac', aliases, readStart: () => null })).toBe('dead');
  });

  it('reads an old-name handle with a reused pid as dead', () => {
    expect(probeHandle(oldHandle, { host: 'Mac', aliases, readStart: () => 'Tue Oct 13 09:00:00 2026' })).toBe('dead');
  });

  it('does not probe another machine even when local aliases are supplied', () => {
    const readStart = vi.fn();
    expect(probeHandle('some-other-host:43287:Mon Oct 12 18:14:01 2026', { host: 'Mac', aliases, readStart })).toBe('foreign');
    expect(readStart).not.toHaveBeenCalled();
  });

  it('keeps exact-match behavior when only host is injected', () => {
    const readStart = vi.fn(() => 'Mon Oct 12 18:14:01 2026');
    expect(probeHandle(oldHandle, { host: 'MacBook-Pro', readStart })).toBe('foreign');
    expect(readStart).not.toHaveBeenCalled();
    expect(probeHandle(oldHandle, { host: 'MacBook-Pro.local', readStart })).toBe('alive');
  });

  it('reads this process as alive and refuses the same pid with another start time (pid reuse)', () => {
    const me = selfHandle();
    expect(me.procStart).toBeTruthy();
    expect(probeHandle(me.handle)).toBe('alive');
    const reused = formatJobHandle({ host: hostName(), pid: process.pid, procStart: 'Thu Jan  1 00:00:00 1970' });
    expect(probeHandle(reused)).toBe('dead');
    expect(probeHandle(formatJobHandle({ host: 'some-other-host', pid: process.pid, procStart: me.procStart }))).toBe('foreign');
  });

  it('reads an exited pid as dead', async () => {
    const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
    const pid = child.pid;
    await new Promise((r) => child.on('exit', r));
    expect(readProcStart(pid)).toBeNull();
  });
});

function launchingRecord(id = 'job-a') {
  enqueueJob({ store, kindDef: noop, id, codeSha: 'sha1', input: { n: 1 } });
  return store.update(id, (r) => markLaunching(r, { at: new Date().toISOString() }));
}

const jobEnv = (id, attempt = 1) => ({ [JOB_ID_ENV]: id, [JOB_ATTEMPT_ENV]: String(attempt), OPERATION_RUNS_DIR: dir });

describe('runJob (child side)', () => {
  it('claims, runs every step, checkpoints each, finishes — and refuses a second run of a finished job', async () => {
    launchingRecord();
    const seen = [];
    const steps = [
      { name: 'one', run: ({ input }) => { seen.push(1); return { got: input.n }; } },
      { name: 'two', run: ({ data }) => { seen.push(2); return { twice: data.got * 2 }; } },
    ];
    expect(await runJob({ steps, env: jobEnv('job-a') })).toEqual({ outcome: 'succeeded' });
    const rec = store.read('job-a');
    expect(rec.job.status).toBe('succeeded');
    expect(rec.job.checkpoint).toEqual({ step: 2, data: { got: 1, twice: 2 } });
    expect(rec.job.timeline.map((e) => e.event)).toEqual(['queued', 'launched', 'started', 'step-applied', 'step-applied', 'finished']);
    expect(await runJob({ steps, env: jobEnv('job-a') })).toMatchObject({ outcome: 'refused', code: 'already-finished' });
    expect(seen).toEqual([1, 2]);
  });

  it('resumes after the last applied step', async () => {
    launchingRecord();
    store.update('job-a', (r) => ({ ...r, job: { ...r.job, checkpoint: { step: 1, data: { got: 5 } } } }));
    const seen = [];
    const steps = [{ name: 'one', run: () => seen.push(1) }, { name: 'two', run: ({ data }) => { seen.push(data.got); } }];
    await runJob({ steps, env: jobEnv('job-a') });
    expect(seen).toEqual([5]);
  });

  it('refuses a launch that is not the current attempt, and a job that is not launching', async () => {
    launchingRecord();
    expect(await runJob({ steps: [], env: jobEnv('job-a', 2) })).toMatchObject({ outcome: 'refused', code: 'not-this-launch' });
    enqueueJob({ store, kindDef: noop, id: 'job-q', codeSha: 's' });
    expect(await runJob({ steps: [], env: jobEnv('job-q', 0) })).toMatchObject({ outcome: 'refused', code: 'not-this-launch' });
  });

  it('stops writing once the record names another process (superseded)', async () => {
    launchingRecord();
    const other = formatJobHandle({ host: hostName(), pid: 1, procStart: 'Thu Jan  1 00:00:00 1970' });
    const steps = [{ name: 'hijacked', run: () => { store.update('job-a', (r) => ({ ...r, job: { ...r.job, handle: other } })); } }];
    expect(await runJob({ steps, env: jobEnv('job-a') })).toMatchObject({ outcome: 'refused', code: 'superseded' });
    expect(store.read('job-a').job.status).toBe('running');
  });

  it('records a step error and leaves the retry to the daemon', async () => {
    launchingRecord();
    const out = await runJob({ steps: [{ name: 'boom', run: () => { throw new Error('boom'); } }], env: jobEnv('job-a') });
    expect(out).toEqual({ outcome: 'error', error: 'boom' });
    const rec = store.read('job-a');
    expect(rec.job.status).toBe('running');
    expect(rec.job.error).toBe('boom');
  });
});

describe('reattachTick', () => {
  const HANDLE = formatJobHandle({ host: 'h', pid: 99, procStart: 'x' });
  const claimed = (id, { heartbeatAt = new Date().toISOString(), attempts = 1 } = {}) => {
    enqueueJob({ store, kindDef: noop, id, codeSha: 's' });
    for (let i = 0; i < attempts; i += 1) store.update(id, (r) => markLaunching(r, { at: new Date().toISOString() }));
    return store.update(id, (r) => markClaimed(r, { at: heartbeatAt, handle: HANDLE, host: 'h', pid: 99, procStart: 'x' }));
  };
  const noLaunch = () => null;

  it('leaves a live job alone, requeues a dead one keeping its checkpoint', async () => {
    claimed('live');
    claimed('dead');
    store.update('dead', (r) => ({ ...r, job: { ...r.job, checkpoint: { step: 1, data: {} } } }));
    const probe = (h) => 'alive';
    let out = await reattachTick({ store, kinds, maxConcurrent: 5, probe, launch: noLaunch, observation: { now: Date.now(), slept: false, gapMs: 0 } });
    expect(out.actions).toEqual([]);
    out = await reattachTick({ store, kinds, maxConcurrent: 5, probe: () => 'dead', launch: noLaunch, observation: { now: Date.now(), slept: false, gapMs: 0 } });
    expect(out.actions.map((a) => [a.id, a.action])).toEqual([['dead', 'requeue'], ['live', 'requeue']]);
    expect(store.read('dead').job).toMatchObject({ status: 'queued', checkpoint: { step: 1 } });
  });

  it('stops a stalled job before requeueing it, and keeps its slot when it will not die', async () => {
    const old = new Date(Date.now() - 120_000).toISOString();
    claimed('stuck', { heartbeatAt: old });
    const stopped = [];
    const obs = { now: Date.now(), slept: false, gapMs: 0 };
    let out = await reattachTick({ store, kinds, maxConcurrent: 5, probe: () => 'alive', stop: async () => ({ gone: false }), launch: noLaunch, observation: obs, staleMs: 60_000 });
    expect(out.actions).toEqual([{ id: 'stuck', state: 'stalled', action: 'stop-failed' }]);
    expect(store.read('stuck').job.status).toBe('running');
    out = await reattachTick({ store, kinds, maxConcurrent: 5, probe: () => 'alive', stop: async (h) => { stopped.push(h); return { gone: true, signal: 'SIGKILL' }; }, launch: noLaunch, observation: obs, staleMs: 60_000 });
    expect(stopped).toEqual([HANDLE]);
    expect(store.read('stuck').job.timeline.map((e) => e.event).slice(-2)).toEqual(['stopped', 'requeued']);
  });

  it('does not judge staleness on a tick that detected a host sleep', async () => {
    claimed('slept', { heartbeatAt: new Date(Date.now() - 600_000).toISOString() });
    const out = await reattachTick({ store, kinds, maxConcurrent: 5, probe: () => 'alive', stop: async () => { throw new Error('must not stop'); }, launch: noLaunch, observation: { now: Date.now(), slept: true, gapMs: 600_000 } });
    expect(out.actions).toEqual([]);
  });

  it('fails visibly on the third dead attempt', async () => {
    claimed('tired', { attempts: 3 });
    const out = await reattachTick({ store, kinds, maxConcurrent: 5, probe: () => 'dead', launch: noLaunch, observation: { now: Date.now(), slept: false, gapMs: 0 } });
    expect(out.actions[0]).toMatchObject({ id: 'tired', action: 'fail' });
    expect(store.read('tired').job).toMatchObject({ status: 'failed', error: expect.stringMatching(/3\/3/) });
  });

  it('launches queued jobs only up to the cap', async () => {
    for (const id of ['a', 'b', 'c']) enqueueJob({ store, kindDef: noop, id, codeSha: 's' });
    const launched = [];
    const launch = ({ id }) => { launched.push(id); return store.update(id, (r) => markLaunching(r, { at: new Date().toISOString() })); };
    await reattachTick({ store, kinds, maxConcurrent: 2, probe: () => 'alive', launch, observation: { now: Date.now(), slept: false, gapMs: 0 } });
    expect(launched).toEqual(['a', 'b']);
    await reattachTick({ store, kinds, maxConcurrent: 2, probe: () => 'alive', launch, observation: { now: Date.now(), slept: false, gapMs: 0 } });
    expect(launched).toEqual(['a', 'b']);
  });
});

describe('stopHandle on a real process', () => {
  it('kills a frozen (SIGSTOPped) process and confirms it is gone', async () => {
    const child = spawnSleeper();
    await waitFor(() => readProcStart(child.pid));
    const handle = formatJobHandle({ host: hostName(), pid: child.pid, procStart: readProcStart(child.pid) });
    process.kill(child.pid, 'SIGSTOP');
    const exited = new Promise((r) => child.on('exit', r));
    const res = await stopHandle(handle, { termGraceMs: 2_000, killGraceMs: 2_000 });
    await exited;
    expect(res.gone).toBe(true);
    expect(probeHandle(handle)).toBe('dead');
  });

  it('never signals a pid whose start time does not match', async () => {
    const child = spawnSleeper();
    await waitFor(() => readProcStart(child.pid));
    const wrong = formatJobHandle({ host: hostName(), pid: child.pid, procStart: 'Thu Jan  1 00:00:00 1970' });
    const res = await stopHandle(wrong, { termGraceMs: 200, killGraceMs: 200 });
    expect(res).toEqual({ gone: true, signal: null });
    expect(readProcStart(child.pid)).toBeTruthy();
    child.kill('SIGKILL');
  });
});

describe('a real detached launch from a pinned snapshot', () => {
  it('runs once, finishes, and a second tick neither relaunches nor restarts it', async () => {
    const materialize = (into) => {
      writeFileSync(join(into, 'job.mjs'), [
        `import { runJob } from ${JSON.stringify(RUNTIME)};`,
        'const out = await runJob({ steps: [{ name: "wait", run: () => new Promise((r) => setTimeout(r, 300)) }] });',
        'process.exit(out.outcome === "succeeded" ? 0 : 1);',
      ].join('\n'));
    };
    enqueueJob({ store, kindDef: noop, id: 'real', codeSha: 'snap1' });
    const tick = () => reattachTick({ store, kinds, maxConcurrent: 1, snapshot: { materialize }, heartbeatIntervalMs: 100 });
    const first = await tick();
    expect(first.actions).toEqual([expect.objectContaining({ id: 'real', action: 'launch', attempt: 1 })]);
    await waitFor(() => store.read('real').job.status === 'succeeded', 15_000);
    const second = await tick();
    expect(second.actions).toEqual([]);
    const events = store.read('real').job.timeline.map((e) => e.event);
    expect(events.filter((e) => e === 'started')).toHaveLength(1);
    expect(events.at(-1)).toBe('finished');
    expect(store.read('real').job.snapshotKeys).toEqual(['code:snap1']);
  }, 30_000);

  it('stamps launchedAt after a slow snapshot build, so the launch grace is not already spent (seen live)', () => {
    let clock = 1_000_000;
    const now = () => clock;
    enqueueJob({ store, kindDef: noop, id: 'slow', codeSha: 'snap3' });
    const out = launchJob({
      store, id: 'slow', kindDef: noop, now, spawnFn: () => 4242,
      snapshot: { materialize: () => { clock += 15_000; } },
    });
    expect(Date.parse(out.job.launchedAt)).toBe(1_015_000);
  });

  it('fails visibly when a readonly-tree job cannot get its snapshot', async () => {
    enqueueJob({ store, kindDef: noop, id: 'nosnap', codeSha: 'snap2' });
    await reattachTick({ store, kinds, maxConcurrent: 1, snapshot: { materialize: () => { throw new Error('archive failed'); } } });
    expect(store.read('nosnap').job).toMatchObject({ status: 'failed', error: expect.stringMatching(/archive failed/) });
  });

  it('refuses to queue a readonly-tree job with no codeSha to pin', () => {
    expect(() => enqueueJob({ store, kindDef: noop, id: 'x' })).toThrow(/codeSha/);
  });
});

describe('reattachTick deadlines', () => {
  it('stops a live expired job before failing it and never starts an expired queued job', async () => {
    const now = Date.now();
    const live = enqueueJob({ store, kindDef: noop, codeSha: 'test-sha', id: 'deadline-live', now });
    store.update(live.id, (r) => markClaimed(markLaunching(r, { at: new Date(now).toISOString() }), {
      at: new Date(now).toISOString(), handle: formatJobHandle({ host: 'test', pid: 123, procStart: 'test' }), host: 'test', pid: 123, procStart: 'test',
    }));
    enqueueJob({ store, kindDef: noop, codeSha: 'test-sha', id: 'deadline-queued', now });
    const stop = vi.fn(async () => ({ gone: true, signal: 'SIGTERM' }));
    const launch = vi.fn();
    await reattachTick({ store, kinds, maxConcurrent: 2, observation: { now, slept: false },
      deadlineAt: () => now, probe: () => 'alive', stop, launch });
    expect(stop).toHaveBeenCalledOnce();
    expect(launch).not.toHaveBeenCalled();
    for (const id of ['deadline-live', 'deadline-queued']) expect(store.read(id).job).toMatchObject({ status: 'failed', error: expect.stringContaining('deadline exceeded') });
  });
  it('keeps an expired job occupying its slot if stopping it fails', async () => {
    const now = Date.now();
    enqueueJob({ store, kindDef: noop, codeSha: 'test-sha', id: 'deadline-stuck', now });
    store.update('deadline-stuck', (r) => markClaimed(markLaunching(r, { at: new Date(now).toISOString() }), {
      at: new Date(now).toISOString(), handle: formatJobHandle({ host: 'test', pid: 123, procStart: 'test' }), host: 'test', pid: 123, procStart: 'test',
    }));
    const out = await reattachTick({ store, kinds, maxConcurrent: 1, observation: { now, slept: false },
      deadlineAt: () => now, probe: () => 'alive', stop: async () => ({ gone: false }), launch: vi.fn() });
    expect(out.actions).toContainEqual(expect.objectContaining({ action: 'stop-failed' }));
    expect(store.read('deadline-stuck').job.status).toBe('running');
  });
});

describe('stopping a job that owns subprocesses', () => {
  it.each([
    // Every keep-alive is anchored to THIS test runner (not its wrapper), so a wrapper's death never ends
    // the child on its own — the group kill under test must.
    ['a wrapper that exits on SIGTERM', '', keepAliveScript(), 'SIGTERM'],
    ['a tree that ignores SIGTERM', "process.on('SIGTERM', () => {});", keepAliveScript({ prelude: "process.on('SIGTERM', () => {});" }), 'SIGKILL'],
    ['a child left running after its wrapper exits', '', keepAliveScript({ prelude: "process.on('SIGTERM', () => {});" }), 'SIGTERM'],
  ])('stops the whole detached process group, not only the wrapper pid: %s', async (_name, parentTrap, childCode, signal) => {
    const parent = spawn(process.execPath, ['-e', [
      parentTrap,
      `const c = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}], { stdio: 'ignore' });`,
      'console.log(c.pid);',
      keepAliveScript(),
    ].join('\n')], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    parent.stdout.on('data', (b) => { out += b; });
    const childPid = Number(await waitFor(() => out.trim()));
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    try {
      await waitFor(() => readProcStart(parent.pid));
      const handle = formatJobHandle({ host: hostName(), pid: parent.pid, procStart: readProcStart(parent.pid) });
      const res = await stopHandle(handle, { termGraceMs: 300, killGraceMs: 3_000 });
      expect(res).toEqual({ gone: true, signal });
      await waitFor(() => !alive(childPid), 3_000);
    } finally {
      for (const pid of [childPid, parent.pid]) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
    }
  });

  it('kills the leftover process group of a job that died on its own before requeuing it', async () => {
    const parent = spawn(process.execPath, ['-e', [
      `const c = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(keepAliveScript())}], { stdio: 'ignore' });`,
      'c.unref(); console.log(c.pid);',
      keepAliveScript(),
    ].join('\n')], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    parent.stdout.on('data', (b) => { out += b; });
    const childPid = Number(await waitFor(() => out.trim()));
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    try {
      const procStart = await waitFor(() => readProcStart(parent.pid));
      const handle = formatJobHandle({ host: hostName(), pid: parent.pid, procStart });
      const exited = new Promise((r) => parent.on('exit', r));
      process.kill(parent.pid, 'SIGKILL'); // the wrapper dies on its own (an OOM kill); its child keeps running
      await exited;
      expect(alive(childPid)).toBe(true);
      const now = Date.now();
      enqueueJob({ store, kindDef: noop, codeSha: 'test-sha', id: 'died-alone', now });
      store.update('died-alone', (r) => markClaimed(markLaunching(r, { at: new Date(now).toISOString() }), {
        at: new Date(now).toISOString(), handle, host: hostName(), pid: parent.pid, procStart,
      }));
      const out2 = await reattachTick({ store, kinds, maxConcurrent: 1, observation: { now, slept: false, gapMs: 0 }, launch: () => null });
      expect(out2.actions).toContainEqual(expect.objectContaining({ id: 'died-alone', action: 'requeue' }));
      await waitFor(() => !alive(childPid), 3_000);
    } finally {
      for (const pid of [childPid, parent.pid]) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
    }
  });

  it('never kills a group for a dead pid that is in use again or not on this host', () => {
    const kill = vi.fn();
    const reused = formatJobHandle({ host: hostName(), pid: process.pid, procStart: 'Thu Jan  1 00:00:00 1970' });
    expect(reapDeadGroup(reused, { kill, notAfterMs: Date.now() })).toBe(false);
    expect(reapDeadGroup(formatJobHandle({ host: 'elsewhere', pid: 999999, procStart: 'x' }), { kill, notAfterMs: Date.now() })).toBe(false);
    // A dead job's unused pid whose group id was taken over later: members started after the job was last
    // alive, or the host rebooted since the job started — never the job's group.
    const procStart = 'Mon Oct 19 00:00:00 2026', started = Date.parse(procStart);
    const dead = formatJobHandle({ host: 'h', pid: 999999, procStart });
    const base = { host: 'h', readStart: () => null, bootTime: () => started - 3600000, kill, notAfterMs: started + 60000 };
    expect(reapDeadGroup(dead, { ...base, groupStarts: () => [started + 120000] })).toBe(false);
    expect(reapDeadGroup(dead, { ...base, groupStarts: () => [started - 60000] })).toBe(false);
    expect(reapDeadGroup(dead, { ...base, bootTime: () => started + 1000, groupStarts: () => [started + 5000] })).toBe(false);
    expect(reapDeadGroup(dead, { ...base, bootTime: () => null, groupStarts: () => [started + 5000] })).toBe(false);
    expect(reapDeadGroup(dead, { ...base, groupStarts: () => null })).toBe(false);
    expect(kill).not.toHaveBeenCalled();
    expect(reapDeadGroup(dead, { ...base, groupStarts: () => [started, started + 5000] })).toBe(true);
    expect(kill).toHaveBeenCalledWith(-999999, 'SIGKILL');
  });

  it('gives a kind its declared stop grace on a deadline stop', async () => {
    const graceful = defineJobKind({ kind: 'graceful', entry: 'job.mjs', stopGraceMs: 45_000 });
    const now = Date.now();
    enqueueJob({ store, kindDef: graceful, codeSha: 'test-sha', id: 'graceful-live', now });
    store.update('graceful-live', (r) => markClaimed(markLaunching(r, { at: new Date(now).toISOString() }), {
      at: new Date(now).toISOString(), handle: formatJobHandle({ host: 'test', pid: 123, procStart: 'test' }), host: 'test', pid: 123, procStart: 'test',
    }));
    const stop = vi.fn(async () => ({ gone: true, signal: 'SIGTERM' }));
    await reattachTick({ store, kinds: kindRegistry([graceful]), maxConcurrent: 1, observation: { now, slept: false },
      deadlineAt: () => now, probe: () => 'alive', stop, launch: vi.fn() });
    expect(stop).toHaveBeenCalledWith(expect.any(String), { termGraceMs: 45_000 });
    expect(() => defineJobKind({ kind: 'bad', entry: 'job.mjs', stopGraceMs: 0 })).toThrow(/stopGraceMs/);
  });
});


function queuedTask(item = 1, timeoutMs = 1000) {
  return enqueueItemTask({ store, kindDef: noop, repo: 'owner/repo', item, seq: 1, codeSha: 's',
    acting: true, resourceKind: 'build', policyOptions: { platform: null, env: {}, tool: { timeoutMs } } });
}
const taskOwner = { handle: 'test:123:start', host: 'test', pid: 123, procStart: 'start' };
function runningTask(item, launchedAt, now) {
  const task = queuedTask(item);
  return store.update(task.id, r => markClaimed(markLaunching(r, { at: new Date(launchedAt).toISOString() }),
    { ...taskOwner, at: new Date(now).toISOString() }));
}

it('task deadlines coexist with legacy absolute deadlines', async () => {
  const now = Date.now();
  const active = runningTask(1, now - 999, now);
  const queued = queuedTask(2);
  const backoff = queuedTask(3);
  store.update(backoff.id, r => ({ ...r, job: { ...r.job, launchedAt: new Date(now - 99999).toISOString(),
    nextAttemptAt: new Date(now + 99999).toISOString() } }));
  for (const kind of ['resource-sampler', 'needs-you-feed']) {
    const def = defineJobKind({ kind, entry: 'job.mjs' });
    enqueueJob({ store, kindDef: def, codeSha: 's', id: kind });
    store.update(kind, r => markClaimed(markLaunching(r, { at: new Date(now - 900000).toISOString() }),
      { ...taskOwner, handle: 'test:124:start', pid: 124, at: new Date(now).toISOString() }));
  }
  enqueueJob({ store, kindDef: noop, codeSha: 's', id: 'coroner-queued' });
  const legacyDeadline = vi.fn(r => r.id === 'coroner-queued' ? now : null);
  const tick = (time, adoptedStore = store) => reattachTick({ store: adoptedStore, kinds, maxConcurrent: 3,
    observation: { now: time, slept: true }, deadlineAt: legacyDeadline, launch: vi.fn(), probe: h => h === taskOwner.handle ? 'dead' : 'alive' });
  // A live probe avoids ordinary crash recovery; neither generation nor store recreation extends the task.
  const first = await reattachTick({ store, kinds, maxConcurrent: 3, observation: { now, slept: false },
    deadlineAt: legacyDeadline, launch: vi.fn(), probe: () => 'alive' });
  expect(first.actions).toEqual([expect.objectContaining({ id: 'coroner-queued', action: 'fail' })]);
  expect(legacyDeadline.mock.calls.every(([r]) => !r.job.task)).toBe(true);
  store.update(active.id, r => ({ ...r, input: { ...r.input, schedulerGeneration: 'adopted' } }));
  await tick(now + 1, createJobStore(dir));
  expect(store.read(active.id).job).toMatchObject({ status: 'queued', task: { failureCount: 1 } });
  expect(store.read(active.id).job.launchedAt).toBe(new Date(now - 999).toISOString());
  for (const r of [queued, backoff]) expect(store.read(r.id).job.task.failureCount).toBe(0);
  for (const id of ['resource-sampler', 'needs-you-feed']) {
    // Ordinary records have no task policy or resource declaration, even after adoption.
    expect(store.read(id).job.task).toBeUndefined();
    expect(store.read(id).job.status).toBe('running');
  }
});

it('task timeout escalates before claim release and retains unconfirmed owners', async () => {
  const now = Date.now(), signals = [], releases = [];
  const active = runningTask(1, now - 1000, now);
  let live = true;
  const probe = () => live ? 'alive' : 'dead';
  const launch = vi.fn();
  const releaseTaskClaim = r => { expect(live).toBe(false); releases.push([r.id, r.job.attempts]); };
  const stop = (h, options) => stopHandle(h, { ...options, probe, termGraceMs: 0, killGraceMs: 0,
    sleep: async () => {}, kill: (pid, signal) => {
      expect(releases).toEqual([]); expect(store.read(active.id).job.status).toBe('running');
      signals.push([pid, signal]); if (signal === 'SIGKILL') live = false;
    } });
  await reattachTick({ store, kinds, maxConcurrent: 1, observation: { now, slept: true },
    probe, stop, launch, releaseTaskClaim });
  expect(signals.slice(0, 3)).toEqual([[-123, 'SIGTERM'], [-123, 'SIGCONT'], [-123, 'SIGKILL']]);
  expect(releases).toEqual([[active.id, 1]]);
  expect(store.read(active.id).job).toMatchObject({ status: 'queued', task: { failureCount: 1 } });
  expect(launch).not.toHaveBeenCalled();

  for (const [index, answer] of ['foreign', undefined, 'throw', 'alive'].entries()) {
    const owner = runningTask(index + 2, now - 1000, now);
    const uncertain = () => { if (answer === 'throw') throw Error('probe unavailable'); return answer; };
    const kill = vi.fn(), release = vi.fn();
    const out = await reattachTick({ store, kinds, maxConcurrent: 1, observation: { now }, probe: uncertain,
      stop: (h, options) => stopHandle(h, { ...options, probe: uncertain, kill,
        termGraceMs: 0, killGraceMs: 0, sleep: async () => {} }), launch, releaseTaskClaim: release });
    expect(out.actions).toContainEqual(expect.objectContaining({ id: owner.id, action: 'stop-failed' }));
    expect(store.read(owner.id).job).toMatchObject({ status: 'running', handle: taskOwner.handle, task: { failureCount: 0 } });
    expect(release).not.toHaveBeenCalled();
    if (answer !== 'alive') {
      expect(kill).not.toHaveBeenCalled();
      expect((await stopHandle(taskOwner.handle, { requireConfirmedDeath: true, probe: uncertain, kill })).gone).toBe(false);
      expect(kill).not.toHaveBeenCalled();
      // Losing probe evidence after SIGTERM must not trigger the dead-group sweep either.
      let observedAlive = true;
      const interruptedKill = vi.fn(() => { observedAlive = false; });
      expect((await stopHandle(taskOwner.handle, { requireConfirmedDeath: true,
        probe: () => observedAlive ? 'alive' : uncertain(), kill: interruptedKill,
        termGraceMs: 0, killGraceMs: 0, sleep: async () => {} })).gone).toBe(false);
      expect(interruptedKill.mock.calls).toEqual([[-123, 'SIGTERM']]);
    }
    expect(() => enqueueItemTask({ store, kindDef: noop, repo: 'owner/repo', item: index + 2, seq: 2,
      codeSha: 's', acting: true, resourceKind: 'build' })).toThrow(/active tuple/);
    expect(launch).not.toHaveBeenCalled();
  }
  // Even a stop adapter claiming success cannot substitute for positive death evidence.
  const retained = await reattachTick({ store, kinds, maxConcurrent: 1, observation: { now }, probe: () => 'foreign',
    stop: async () => ({ gone: true }), launch, releaseTaskClaim: vi.fn(() => { throw Error('must retain'); }) });
  expect(retained.actions.every(a => a.action === 'stop-failed')).toBe(true);

  for (const r of store.list().records) store.update(r.id, f => markSucceeded(f, { at: new Date(now).toISOString() }));
  for (const [index, race] of ['finish', 'attempt', 'handle'].entries()) {
    const owner = runningTask(index + 10, now - 1000, now), release = vi.fn();
    let dead = false;
    await reattachTick({ store, kinds, maxConcurrent: 1, observation: { now }, probe: () => dead ? 'dead' : 'alive',
      stop: async () => {
        store.update(owner.id, r => race === 'finish' ? markSucceeded(r, { at: new Date(now).toISOString() })
          : { ...r, job: { ...r.job, ...(race === 'attempt' ? { attempts: r.job.attempts + 1 } : { handle: 'test:456:new' }) } });
        dead = true; return { gone: true, signal: 'SIGKILL' };
      }, launch, releaseTaskClaim: release });
    expect(release).not.toHaveBeenCalled();
    expect(store.read(owner.id).job.task.failureCount).toBe(0);
    store.update(owner.id, r => markSucceeded(r, { at: new Date(now).toISOString() }));
  }
  const unclaimed = queuedTask(20);
  store.update(unclaimed.id, r => {
    const launched = markLaunching(r, { at: new Date(now - 1000).toISOString() });
    return { ...launched, job: { ...launched.job, attempts: 10 } };
  });
  const noStop = vi.fn();
  await reattachTick({ store, kinds, maxConcurrent: 1, observation: { now }, stop: noStop, launch });
  expect(noStop).not.toHaveBeenCalled();
  expect(store.read(unclaimed.id).job).toMatchObject({ status: 'queued', attempts: 10, task: { failureCount: 1 } });
  // Timeout exhaustion uses semantic failures, independently of the monotonic attempt token.
  const exhausted = runningTask(21, now - 1000, now);
  store.update(exhausted.id, r => ({ ...r, job: { ...r.job, task: { ...r.job.task, failureCount: 2 } } }));
  await reattachTick({ store, kinds, maxConcurrent: 1, observation: { now }, probe: () => 'dead', launch });
  expect(store.read(exhausted.id).job).toMatchObject({ status: 'failed', attempts: 1, task: { failureCount: 3 } });
});


it.each([false, true])('reaps a task group when the owner dies between the tick probe and stop, saved result=%s', async saved => {
  const now = Date.now(), owner = runningTask(900, now - 1000, now);
  if (saved) store.update(owner.id, r => ({ ...r, job: { ...r.job, task: { ...r.job.task,
    execution: { effects: {}, timings: {}, results: { 1: { v: 1, taskId: r.job.task.id, attempt: 1,
      outcome: 'acted', effects: [], recordedReads: [], timings: {}, gh: { read: 0, write: 0 } } } },
  } } }));
  let observations = 0, descendantAlive = true;
  const probe = () => ++observations === 1 ? 'alive' : 'dead';
  const kill = vi.fn();
  const reapGroup = vi.fn(() => { descendantAlive = false; return true; });
  const release = vi.fn(() => { expect(descendantAlive).toBe(false); });
  await reattachTick({ store, kinds, maxConcurrent: 1, observation: { now }, probe,
    stop: (h, options) => stopHandle(h, { ...options, probe, kill }),
    reapGroup, releaseTaskClaim: release, launch: vi.fn() });
  expect(kill).not.toHaveBeenCalled(); // stopHandle first sees a dead owner
  expect(reapGroup).toHaveBeenCalledWith(owner.job.handle, now + 60000);
  expect(release).toHaveBeenCalledTimes(1);
  expect(store.read(owner.id).job).toMatchObject({ status: saved ? 'succeeded' : 'queued',
    task: { failureCount: saved ? 0 : 1 } });
});

function childTaskStep(id, { act = () => ({}), timing = () => {}, mutate = () => {}, onRead = () => {}, onClaim = () => {}, names = ['first'], precondition = 'none' } = {}) {
  const facts = () => createRecordingFacts({ load: () => ({ identity: { repo: 'owner/repo', item: store.read(id).job.task.item },
    observedAt: 1, source: 'live-pr', complete: true, data: { head: 'abc' } }),
    expectedIdentity: { repo: 'owner/repo', item: store.read(id).job.task.item }, now: 1, snapshotMaxAgeMs: 100 });
  return { name: 'task', run: async ({ task }) => {
    mutate(task);
    return runItemTask({ ...task, read: () => { onRead(); return facts(); }, plan: f => { f.read('head'); return names.map(name => ({ name,
      inputs: ['head'], fences: ['head'], appliedProbe: 'worker-run', precondition })); },
      budgets: { read: 10, write: 10 }, runStore: { find: () => null },
      claim: { acquire: () => { onClaim(); return 'claim'; }, assert: () => true, release: () => {} },
      effects: { fence: facts, act: context => {
        expect(store.read(id).job.task.execution.effects[context.effectId].status).toBe('intent');
        return act(context);
      } }, timing });
  } };
}
const runTaskChild = (id, step, attempt = 1) => runJob({ steps: [step], env: jobEnv(id, attempt),
  host: 'test', pid: 123, readStart: () => 'start' });

it.each([false, true])('structured preconditions persist through child intent, act and result, rejected=%s', async rejected => {
  const owner = queuedTask(901, 300000), precondition = { ifMatch: 'abc' };
  store.update(owner.id, r => markLaunching(r, { at: new Date().toISOString() }));
  const act = vi.fn(context => {
    expect(context.precondition).toEqual(precondition);
    expect(store.read(owner.id).job.task.execution.effects[context.effectId]).toMatchObject({ status: 'intent', precondition });
    if (rejected) throw Error('server precondition rejected');
    return { applied: true };
  });
  await runTaskChild(owner.id, childTaskStep(owner.id, { precondition, act }));
  expect(act).toHaveBeenCalledTimes(1);
  const saved = store.read(owner.id);
  const result = saved.job.task.execution.results[1];
  expect(result.outcome).toBe(rejected ? 'failed' : 'acted');
  expect(result.effects[0]).toMatchObject({ precondition, status: rejected ? 'intent' : 'applied' });
  expect(JSON.parse(readFileSync(join(dir, `results/${owner.id}-1.json`), 'utf8'))).toEqual(result);
});

it.each([1, 3, 4])('persisted failed results with failureCount=%s complete in the child and dead-owner recovery', async failureCount => {
  const now = Date.now(), launch = vi.fn(), release = vi.fn();
  for (const recover of [false, true]) {
    const r = queuedTask(recover ? 402 : 401, 300000);
    store.update(r.id, f => markLaunching(f, { at: new Date(now).toISOString() }));
    const result = { v: 1, taskId: r.job.task.id, attempt: 1, outcome: 'failed',
      ...(failureCount === 1 ? { reason: 'effect refused' } : {}),
      effects: [], recordedReads: [], timings: {}, gh: { read: 0, write: 0 } };
    const child = await runTaskChild(r.id, { name: 'persist failure', run: ({ task }) => {
      task.record.update(f => {
        f.job.checkpoint = { step: 0, data: { retained: true } };
        Object.assign(f.job.task, { outcome: 'failed', failureCount,
          execution: { effects: {}, results: { 1: result }, timings: {} } });
        return f;
      });
      if (recover) throw Error('crash after persistence');
      return { completed: true };
    } });
    expect(child).toEqual({ outcome: 'error', error: recover ? 'crash after persistence' : 'failed' });
    const tick = () => reattachTick({ store, kinds, maxConcurrent: 1, observation: { now },
      probe: () => 'dead', launch, releaseTaskClaim: release, reapGroup: () => false });
    await tick();
    const finished = store.read(r.id);
    expect(finished.job).toMatchObject({ status: failureCount >= 3 ? 'failed' : 'queued', attempts: 1,
      handle: null, task: { outcome: 'failed', failureCount, execution: { results: { 1: result } } } });
    if (failureCount >= 3) {
      expect(finished.job.error).toBe('failed');
      expect(finished.job.finishedAt).toEqual(expect.any(String));
    } else {
      expect(finished.job.checkpoint).toEqual({ step: 0, data: {} });
      expect(Date.parse(finished.job.nextAttemptAt)).toBeGreaterThan(now);
      expect(finished.job.timeline).toContainEqual(expect.objectContaining({ event: 'requeued', resume: false, reason: 'effect refused' }));
    }
    expect(JSON.parse(readFileSync(join(dir, `results/${r.id}-1.json`), 'utf8'))).toEqual(result);
    await tick();
    expect(store.read(r.id)).toEqual(finished);
  }
  expect(release).toHaveBeenCalledTimes(1);
  expect(launch).not.toHaveBeenCalled();
});

it('result repair skips unchanged record and sidecar writes on repeated terminal ticks', async () => {
  const r = queuedTask(403, 300000);
  store.update(r.id, f => markLaunching(f, { at: new Date().toISOString() }));
  expect(await runTaskChild(r.id, childTaskStep(r.id))).toEqual({ outcome: 'succeeded' });
  const recordPath = runPath(r.id, dir), resultPath = join(dir, `results/${r.id}-1.json`);
  const saved = store.read(r.id);
  const sentinel = new Date('2000-01-01T00:00:00Z');
  utimesSync(recordPath, sentinel, sentinel);
  utimesSync(resultPath, sentinel, sentinel);
  const tick = () => reattachTick({ store, kinds, maxConcurrent: 1 });
  await tick();
  await tick();
  expect(statSync(recordPath).mtimeMs).toBe(sentinel.getTime());
  expect(statSync(resultPath).mtimeMs).toBe(sentinel.getTime());
  rmSync(resultPath);
  await tick();
  expect(JSON.parse(readFileSync(resultPath, 'utf8'))).toEqual(saved.job.task.execution.results[1]);
  expect(statSync(recordPath).mtimeMs).toBe(sentinel.getTime());
  expect(store.read(r.id)).toEqual(saved);
});

it.each([false, true])('overdue persisted results escalate the owner, confirmed death=%s', async confirmed => {
  const now = Date.now(), owner = runningTask(301, now - 1000, now);
  const result = { v: 1, taskId: owner.job.task.id, attempt: 1, outcome: 'acted',
    effects: [], recordedReads: [], timings: {}, gh: { read: 0, write: 0 } };
  store.update(owner.id, r => ({ ...r, job: { ...r.job, task: { ...r.job.task, outcome: 'acted',
    execution: { effects: {}, results: { 1: result }, timings: {} } } } }));
  let alive = true;
  const signals = [], release = vi.fn(), launch = vi.fn();
  const probe = () => alive ? 'alive' : 'dead';
  const out = await reattachTick({ store, kinds, maxConcurrent: 1, observation: { now }, probe, launch,
    releaseTaskClaim: release, stop: (h, options) => stopHandle(h, { ...options, probe,
      termGraceMs: 0, killGraceMs: 0, sleep: async () => {}, kill: (pid, signal) => {
        signals.push(signal);
        expect(release).not.toHaveBeenCalled();
        if (confirmed && signal === 'SIGKILL') alive = false;
      } }) });
  expect(signals.slice(0, 3)).toEqual(['SIGTERM', 'SIGCONT', 'SIGKILL']);
  expect(store.read(owner.id).job).toMatchObject({ status: confirmed ? 'succeeded' : 'running',
    handle: confirmed ? null : taskOwner.handle, task: { failureCount: 0 } });
  expect(release).toHaveBeenCalledTimes(confirmed ? 1 : 0);
  if (!confirmed) expect(out.actions).toContainEqual(expect.objectContaining({ id: owner.id, action: 'stop-failed' }));
  expect(JSON.parse(readFileSync(join(dir, `results/${owner.id}-1.json`), 'utf8'))).toEqual(result);
  expect(launch).not.toHaveBeenCalled();
});

it.each(['saved', 'dead', 'stopped'])('claim-release refusal under lock retains the %s record and continues the tick', async mode => {
  const now = Date.now();
  runningTask(302, now - 1000, now);
  runningTask(303, now - 1000, now);
  const [owner, other] = store.list().records;
  if (mode === 'saved') store.update(owner.id, r => ({ ...r, job: { ...r.job, task: { ...r.job.task,
    resultRef: `results/${owner.id}-1.json`, execution: { effects: {}, timings: {}, results: { 1: {
      v: 1, taskId: owner.job.task.id, attempt: 1, outcome: 'acted',
      effects: [], recordedReads: [], timings: {}, gh: { read: 0, write: 0 } } } } } } }));
  const before = store.read(owner.id), launch = vi.fn(), logs = [];
  const waiting = queuedTask(305);
  let stopped = false;
  const release = vi.fn(r => {
    expect(existsSync(join(dir, `${r.id}.json.lock`))).toBe(true);
    if (r.id === owner.id) throw Error('claim release refused');
  });
  await expect(reattachTick({ store, kinds, maxConcurrent: 1, observation: { now }, launch,
    probe: () => mode === 'stopped' && !stopped ? 'alive' : 'dead',
    stop: async () => { stopped = true; return { gone: true, signal: 'SIGKILL' }; },
    reapGroup: () => false, releaseTaskClaim: release, log: m => logs.push(m) })).resolves.toBeDefined();
  expect(store.read(owner.id)).toEqual(before);
  expect(store.read(other.id).job).toMatchObject({ status: 'queued', task: { failureCount: 1 } });
  expect(store.read(waiting.id).job.status).toBe('queued');
  expect(release.mock.calls.map(([r]) => r.id)).toEqual([owner.id, other.id]);
  expect(logs.some(m => m.includes(owner.id) && m.includes('claim release refused'))).toBe(true);
  expect(launch).not.toHaveBeenCalled();
});

it('a handle with no parsed pid cannot confirm death or release a task owner', async () => {
  const kill = vi.fn(), release = vi.fn(), launch = vi.fn(), now = Date.now();
  expect(await stopHandle('no-pid', { requireConfirmedDeath: true, kill })).toEqual({ gone: false, signal: null });
  const owner = runningTask(304, now - 1000, now);
  const before = store.read(owner.id);
  await reattachTick({ store, kinds, maxConcurrent: 1, observation: { now }, probe: () => 'alive',
    stop: (h, options) => stopHandle('no-pid', { ...options, kill }), releaseTaskClaim: release, launch });
  expect(store.read(owner.id)).toEqual(before);
  expect(kill).not.toHaveBeenCalled();
  expect(release).not.toHaveBeenCalled();
  expect(launch).not.toHaveBeenCalled();
});

it.each(['acted', 'nothing-owed', 'superseded', 'deferred-claim-held', 'deferred-read'])(
  'non-failure outcome %s succeeds in the child and after persisted-result recovery', async outcome => {
    const now = Date.now(), launch = vi.fn(), release = vi.fn();
    for (const recover of [false, true]) {
      const r = queuedTask(recover ? 202 : 201, 300000);
      store.update(r.id, f => markLaunching(f, { at: new Date(now).toISOString() }));
      const result = { v: 1, taskId: r.job.task.id, attempt: 1, outcome,
        effects: [], recordedReads: [], timings: {}, gh: { read: 0, write: 0 } };
      const child = await runTaskChild(r.id, { name: 'semantic completion', run: ({ task }) => {
        task.record.update(f => {
          f.job.task.outcome = outcome;
          f.job.task.execution = { effects: {}, results: { 1: result }, timings: {} };
          return f;
        });
        if (recover) throw Error('crash after semantic persistence');
      } });
      expect(child.outcome).toBe(recover ? 'error' : 'succeeded');
      const tick = () => reattachTick({ store, kinds, maxConcurrent: 1, observation: { now },
        probe: () => 'dead', launch, releaseTaskClaim: release });
      await tick();
      await tick();
      expect(store.read(r.id).job).toMatchObject({ status: 'succeeded', attempts: 1,
        task: { outcome, failureCount: 0, execution: { results: { 1: result } } } });
      expect(JSON.parse(readFileSync(join(dir, `results/${r.id}-1.json`), 'utf8'))).toEqual(result);
    }
    expect(launch).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

it('confirmed-dead task owners before deadline exhaust semantic failures independently of launch attempts', async () => {
  const now = Date.now(), launch = vi.fn(), release = vi.fn();
  const retry = runningTask(203, now - 1, now), exhausted = runningTask(204, now - 1, now);
  store.update(retry.id, r => ({ ...r, job: { ...r.job, attempts: 10 } }));
  store.update(exhausted.id, r => ({ ...r, job: { ...r.job, task: { ...r.job.task, failureCount: 2 } } }));
  const tick = () => reattachTick({ store, kinds, maxConcurrent: 1, observation: { now },
    probe: () => 'dead', launch, releaseTaskClaim: release });
  await tick();
  expect(store.read(retry.id).job).toMatchObject({ status: 'queued', attempts: 10,
    task: { outcome: 'failed', failureCount: 1 } });
  expect(Date.parse(store.read(retry.id).job.nextAttemptAt)).toBeGreaterThan(now);
  expect(store.read(exhausted.id).job).toMatchObject({ status: 'failed', attempts: 1,
    task: { outcome: 'failed', failureCount: 3 } });
  await tick();
  expect(store.read(retry.id).job.task.failureCount).toBe(1);
  expect(store.read(exhausted.id).job.task.failureCount).toBe(3);
  expect(release).toHaveBeenCalledTimes(2);
  expect(launch).not.toHaveBeenCalled();
});

it('task results repair publication without replay and retain partial success', async () => {
  const now = Date.now(), act = vi.fn(({ effect }) => {
    if (effect.name === 'second') throw Error('partial failure');
    return { receipt: 'first-applied' };
  });
  const r = queuedTask(101, 300000);
  store.update(r.id, f => markLaunching(f, { at: new Date(now).toISOString() }));
  const crash = () => { throw Error('crash after persistence'); };
  expect(await runTaskChild(r.id, childTaskStep(r.id, { names: ['first', 'second'], act, timing: crash }))).toMatchObject({ outcome: 'error' });
  const saved = store.read(r.id).job.task.execution.results[1];
  expect(saved).toMatchObject({ v: 1, attempt: 1, outcome: 'failed', effects: [
    expect.objectContaining({ status: 'applied', evidence: { receipt: 'first-applied' } }), expect.objectContaining({ status: 'intent' })] });
  const reaped = vi.fn(() => false);
  const release = vi.fn(() => { expect(reaped).toHaveBeenCalled(); }), launch = vi.fn();
  const tick = probe => reattachTick({ store: createJobStore(dir), kinds, maxConcurrent: 1,
    observation: { now, slept: false }, probe: () => probe, launch, releaseTaskClaim: release, reapGroup: reaped });
  await tick('alive');
  const ref1 = `results/${r.id}-1.json`;
  expect(JSON.parse(readFileSync(join(dir, ref1), 'utf8'))).toEqual(saved);
  expect(store.read(r.id).job).toMatchObject({ status: 'running', handle: taskOwner.handle, task: { failureCount: 1 } });
  expect(release).not.toHaveBeenCalled();
  writeFileSync(join(dir, ref1), '{');
  writeFileSync(join(dir, 'torn-root.json'), '{');
  expect((await tick('alive')).corrupt).toEqual(['torn-root']);
  expect(readFileSync(join(dir, 'torn-root.json'), 'utf8')).toBe('{');
  expect(JSON.parse(readFileSync(join(dir, ref1), 'utf8'))).toEqual(saved);
  await tick('dead');
  expect(store.read(r.id).job).toMatchObject({ status: 'queued', task: { failureCount: 1 } });
  store.update(r.id, f => markLaunching(f, { at: new Date(now).toISOString() }));
  expect(await runTaskChild(r.id, childTaskStep(r.id, { timing: crash }), 2)).toMatchObject({ outcome: 'error' });
  const success = store.read(r.id).job.task.execution.results[2];
  expect(success.outcome).toBe('acted');
  await tick('dead');
  expect(store.read(r.id).job).toMatchObject({ status: 'succeeded', task: { failureCount: 1, resultRef: `results/${r.id}-2.json` } });
  rmSync(join(dir, `results/${r.id}-2.json`));
  await tick('dead');
  await tick('dead');
  expect(JSON.parse(readFileSync(join(dir, `results/${r.id}-2.json`), 'utf8'))).toEqual(success);
  expect(JSON.parse(readFileSync(join(dir, ref1), 'utf8'))).toEqual(saved);
  expect(store.read(r.id).job.task.execution.results).toEqual({ 1: saved, 2: success });
  expect(act).toHaveBeenCalledTimes(2);
  expect(launch).not.toHaveBeenCalled();
  expect(release).toHaveBeenCalledTimes(2);
});

it('task child hooks persist intent before act and refuse stale writers', async () => {
  const r = queuedTask(102, 300000);
  store.update(r.id, f => markLaunching(f, { at: new Date().toISOString() }));
  let hooks;
  const out = await runTaskChild(r.id, childTaskStep(r.id, { mutate: task => { hooks = task; }, timing: () => {
    expect(store.read(r.id).job.status).toBe('running');
    expect(store.read(r.id).job.task.execution.results[1].outcome).toBe('acted');
  } }));
  expect(out.outcome).toBe('succeeded');
  expect(() => hooks.record.update(f => f)).toThrow(expect.objectContaining({ code: 'superseded' }));
  expect(() => hooks.record.read()).toThrow(expect.objectContaining({ code: 'superseded' }));
  for (const change of ['attempt', 'status', 'handle']) {
    const next = queuedTask(103 + ['attempt', 'status', 'handle'].indexOf(change), 300000);
    store.update(next.id, f => markLaunching(f, { at: new Date().toISOString() }));
    const act = vi.fn(), onRead = vi.fn(), onClaim = vi.fn();
    const step = childTaskStep(next.id, { act, onRead, onClaim, mutate: () => store.update(next.id, f => ({ ...f, job: { ...f.job,
      ...(change === 'attempt' ? { attempts: 2 } : change === 'status' ? { status: 'succeeded' } : { handle: 'test:456:other' }) } })) });
    expect(await runTaskChild(next.id, step)).toMatchObject({ outcome: 'refused', code: 'superseded' });
    expect(act).not.toHaveBeenCalled();
    expect(onRead).not.toHaveBeenCalled();
    expect(onClaim).not.toHaveBeenCalled();
    expect(store.read(next.id).job.task.execution).toBeUndefined();
  }
  const late = queuedTask(107);
  store.update(late.id, f => markLaunching(f, { at: new Date(0).toISOString() }));
  await reattachTick({ store, kinds, maxConcurrent: 1, observation: { now: Date.now(), slept: false }, launch: vi.fn() });
  const step = { name: 'no reads claims effects', run: vi.fn() };
  expect(await runTaskChild(late.id, step)).toMatchObject({ outcome: 'refused', code: 'not-this-launch' });
  expect(step.run).not.toHaveBeenCalled();
  const incomplete = queuedTask(108);
  store.update(incomplete.id, f => markLaunching(f, { at: new Date().toISOString() }));
  expect(await runTaskChild(incomplete.id, { name: 'missing semantic result', run: () => ({}) })).toMatchObject({ outcome: 'refused', code: 'task-incomplete' });
  expect(store.read(incomplete.id).job.status).toBe('running');
});


it('legacy child steps retain their checkpoint and context without task hooks', async () => {
  launchingRecord('legacy-hooks');
  const run = vi.fn(ctx => { expect(ctx).not.toHaveProperty('task'); return { kept: 1 }; });
  expect(await runJob({ steps: [{ name: 'legacy', run }], env: jobEnv('legacy-hooks'),
    host: 'test', pid: 123, readStart: () => 'start' })).toEqual({ outcome: 'succeeded' });
  expect(store.read('legacy-hooks').job.checkpoint).toEqual({ step: 1, data: { kept: 1 } });
});


it('task timeout honors semantic completion persisted while stopping without another failure charge', async () => {
  const now = Date.now(), owner = runningTask(109, now - 1000, now);
  store.update(owner.id, r => ({ ...r, job: { ...r.job, task: { ...r.job.task, failureCount: 2 } } }));
  const result = { v: 1, taskId: owner.job.task.id, attempt: 1, outcome: 'acted',
    effects: [], recordedReads: [], timings: {}, gh: { read: 0, write: 0 } };
  let alive = true;
  const stop = vi.fn(async () => {
    store.update(owner.id, r => ({ ...r, job: { ...r.job, task: { ...r.job.task, outcome: 'acted',
      execution: { effects: {}, results: { 1: result }, timings: {} } } } }));
    alive = false;
    return { gone: true, signal: 'SIGTERM' };
  });
  const release = vi.fn(() => { expect(alive).toBe(false); }), launch = vi.fn();
  const tick = () => reattachTick({ store, kinds, maxConcurrent: 1, observation: { now, slept: false },
    probe: () => alive ? 'alive' : 'dead', stop, releaseTaskClaim: release, launch });
  const out = await tick();
  expect(store.read(owner.id).job).toMatchObject({ status: 'succeeded', attempts: 1,
    task: { outcome: 'acted', failureCount: 2, execution: { results: { 1: result } } } });
  expect(out.actions.some(a => a.action === 'fail' || a.action === 'requeue')).toBe(false);
  expect(JSON.parse(readFileSync(join(dir, `results/${owner.id}-1.json`), 'utf8'))).toEqual(result);
  await tick();
  expect(store.read(owner.id).job.task.failureCount).toBe(2);
  expect(stop).toHaveBeenCalledTimes(1);
  expect(release).toHaveBeenCalledTimes(1);
  expect(launch).not.toHaveBeenCalled();
});
