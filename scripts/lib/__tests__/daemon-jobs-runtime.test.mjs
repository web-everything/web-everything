/**
 * @file scripts/lib/__tests__/daemon-jobs-runtime.test.mjs
 * @description #4125 — the job runtime on real processes and a real temp jobs folder: handle liveness via
 *   `ps` (a reused pid is refused), the child's claim / resume / supersede rules, the reattach tick (dead →
 *   requeued, stalled → stopped then requeued, 3 attempts → failed, the cap), stopping a frozen process, and
 *   one real detached launch from a pinned snapshot that finishes exactly once.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keepAliveScript, spawnKeepAlive } from '../test-keepalive.mjs';

import {
  JOB_ATTEMPT_ENV, JOB_ID_ENV, createJobStore, enqueueJob, hostName, launchJob, localHostAliases, probeHandle, readProcStart,
  reapDeadGroup, reattachTick, runJob, selfHandle, stopHandle,
} from '../daemon-jobs-runtime.mjs';
import { defineJobKind, kindRegistry, markClaimed, markLaunching } from '../daemon-jobs.mjs';
import { formatJobHandle } from '../../operations/job-record.mjs';

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
