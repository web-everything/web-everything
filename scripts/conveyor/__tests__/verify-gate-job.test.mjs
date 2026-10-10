/**
 * @file scripts/conveyor/__tests__/verify-gate-job.test.mjs
 * @description #4135 — each verify gate runs as a detached durable job. Covers the pure outcome/ownership rules,
 *   the job child's step (stale request, relaunch over a surviving gate, result + gate sidecar) and the daemon's
 *   store-backed registry (re-attach, consume-once, failure reporting) against a REAL job store in a temp dir.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  classifyGateOutcome, markerStillOurs, runGateStep, createVerifyGateJobs, resolveGateAsJob, killGateGroup,
  gatePath, resultPath, VERIFY_GATE_JOB_KIND,
} from '../verify-gate-job.mjs';
import { createJobStore, enqueueJob } from '../../lib/daemon-jobs-runtime.mjs';
import { markClaimed, markFailed, markLaunching, markSucceeded } from '../../lib/daemon-jobs.mjs';

let dir;
let store;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'verify-gate-job-'));
  store = createJobStore(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const INPUT = { pool: 'we', lane: 3, dir: '/lanes/we/lane-3', headSha: 'abc12345', runId: 'run-1', suites: 'true', treeHash: 't1',
  requestStartedAt: '2026-10-10T10:00:00.000Z' };
const AT = '2026-10-10T10:00:01.000Z';

describe('pure rules', () => {
  it('classifyGateOutcome mirrors the in-process settle: green, red (exit 2), timed-out, failed', () => {
    expect(classifyGateOutcome({ ok: true })).toEqual({ outcome: 'green' });
    expect(classifyGateOutcome({ ok: false, error: { status: 2 } })).toEqual({ outcome: 'red' });
    expect(classifyGateOutcome({ ok: false, error: { timedOutPhase: 'queue', status: null } })).toEqual({ outcome: 'timed-out', timedOutPhase: 'queue' });
    expect(classifyGateOutcome({ ok: false, error: { status: 1, message: 'boom\nmore' } })).toMatchObject({ outcome: 'failed', status: 1, message: 'boom' });
  });

  it('markerStillOurs: the observed request or our own stamp, running for HEAD — nothing else', () => {
    const request = { status: 'running', sha: 'abc12345', startedAt: INPUT.requestStartedAt };
    expect(markerStillOurs(request, 'abc12345', INPUT)).toBe(true);
    expect(markerStillOurs({ ...request, runId: 'run-1', startedAt: 'later' }, 'abc12345', INPUT)).toBe(true);
    expect(markerStillOurs({ ...request, startedAt: 'newer-request' }, 'abc12345', INPUT)).toBe(false);
    expect(markerStillOurs({ ...request, status: 'green' }, 'abc12345', INPUT)).toBe(false);
    expect(markerStillOurs(request, 'moved999', INPUT)).toBe(false);
  });

  it('job mode is on by default; WE_VERIFY_GATE_AS_JOB=0 restores the in-process gate', () => {
    expect(resolveGateAsJob({})).toBe(true);
    expect(resolveGateAsJob({ WE_VERIFY_GATE_AS_JOB: '0' })).toBe(false);
  });
});

describe('runGateStep — the job child', () => {
  const running = { status: 'running', sha: 'abc12345', startedAt: INPUT.requestStartedAt, suites: 'true' };

  it('runs nothing when the marker is no longer this request, and records why', async () => {
    const runGate = vi.fn();
    const out = await runGateStep({ jobId: 'j1', input: INPUT, jobsDir: dir, runGate, log: () => {},
      laneState: () => ({ marker: { ...running, status: 'green' }, headSha: 'abc12345' }) });
    expect(runGate).not.toHaveBeenCalled();
    expect(out.outcome).toBe('stale');
    expect(JSON.parse(readFileSync(resultPath(dir, 'j1'), 'utf8'))).toMatchObject({ outcome: 'stale', marker: { status: 'green' } });
  });

  it('runs the gate with the job identity, records the gate handle and start, and the verdict', async () => {
    let calls = 0;
    const laneState = () => (calls++ === 0 ? { marker: running, headSha: 'abc12345' } : { marker: { ...running, status: 'red', runId: 'run-1' }, headSha: 'abc12345' });
    const runGate = vi.fn(async (o) => {
      o.onSpawn(4242);
      o.onGateStarted();
      const e = new Error('verify-lane exited with code 2'); e.status = 2; throw e;
    });
    const out = await runGateStep({ jobId: 'j2', input: INPUT, jobsDir: dir, runGate, laneState, log: () => {},
      readStart: () => 'Sat Oct 10 10:00:00 2026', probe: () => 'dead' });
    expect(runGate.mock.calls[0][0]).toMatchObject({ dir: INPUT.dir, runId: 'run-1', headSha: 'abc12345', marker: { suites: 'true', startedAt: INPUT.requestStartedAt } });
    const gate = JSON.parse(readFileSync(gatePath(dir, 'j2'), 'utf8'));
    expect(gate.pid).toBe(4242);
    expect(gate.handle).toMatch(/:4242:/);
    expect(gate.gateStartedAt).toBeTruthy();
    expect(out.outcome).toBe('red');
    expect(JSON.parse(readFileSync(resultPath(dir, 'j2'), 'utf8'))).toMatchObject({ outcome: 'red', marker: { status: 'red', runId: 'run-1' } });
  });

  it('a relaunch kills a previous attempt\'s gate that is still alive before re-checking the marker', async () => {
    writeFileSync(gatePath(dir, 'j3'), JSON.stringify({ pid: 777, handle: 'h:777:x' }));
    let alive = true;
    const kill = vi.fn(() => { alive = false; });
    const out = await runGateStep({ jobId: 'j3', input: INPUT, jobsDir: dir, attempt: 2, log: () => {}, kill,
      probe: () => (alive ? 'alive' : 'dead'), sleep: async () => {},
      laneState: () => ({ marker: { ...running, status: 'infrastructure-failure' }, headSha: 'abc12345' }), runGate: vi.fn() });
    expect(kill).toHaveBeenCalledWith(-777, 'SIGKILL');
    expect(out.outcome).toBe('stale');
  });

  it('a relaunch refuses to start a second gate while the previous gate survives the kill', async () => {
    writeFileSync(gatePath(dir, 'j4'), JSON.stringify({ pid: 778, handle: 'h:778:x' }));
    const kill = vi.fn(); // SIGKILL has no effect (EPERM / uninterruptible): the probe stays alive
    const runGate = vi.fn();
    const sleep = vi.fn(async () => {});
    const logs = [];
    const out = await runGateStep({ jobId: 'j4', input: INPUT, jobsDir: dir, attempt: 2, log: (m) => logs.push(m), kill,
      probe: () => 'alive', sleep, laneState: () => ({ marker: running, headSha: 'abc12345' }), runGate });
    expect(kill).toHaveBeenCalledWith(-778, 'SIGKILL');
    expect(runGate).not.toHaveBeenCalled();
    expect(out.outcome).toBe('failed');
    const result = JSON.parse(readFileSync(resultPath(dir, 'j4'), 'utf8'));
    expect(result).toMatchObject({ outcome: 'failed', attempt: 2 });
    expect(result.message).toMatch(/778/);
  });

  it('a relaunch whose kill is slow but lands within the wait still runs the gate', async () => {
    writeFileSync(gatePath(dir, 'j5'), JSON.stringify({ pid: 779, handle: 'h:779:x' }));
    let polls = 0;
    const runGate = vi.fn(async () => {});
    const out = await runGateStep({ jobId: 'j5', input: INPUT, jobsDir: dir, attempt: 2, log: () => {}, kill: vi.fn(),
      probe: () => { polls += 1; return polls > 3 ? 'dead' : 'alive'; }, sleep: async () => {},
      laneState: () => ({ marker: running, headSha: 'abc12345' }), runGate });
    expect(runGate).toHaveBeenCalledTimes(1);
    expect(out.outcome).toBe('green');
  });
});

describe('createVerifyGateJobs — the daemon side over a real job store', () => {
  const noReattach = async () => ({ actions: [] });
  const mk = (extra = {}) => createVerifyGateJobs({ store, reattach: noReattach, readHead: () => 'c0de', log: () => {},
    probe: () => 'alive', evict: () => {}, snapshot: {}, ...extra });

  it('launch queues a readonly-tree job pinned to the clone HEAD with the request identity', () => {
    const jobs = mk();
    const rec = jobs.launch({ pool: 'we', lane: 3, dir: INPUT.dir, headSha: 'abc12345', runId: 'run-1',
      marker: { suites: 'true', treeHash: 't1', startedAt: INPUT.requestStartedAt } });
    expect(rec.job).toMatchObject({ kind: 'verify-gate', status: 'queued', codeSha: 'c0de', codeMode: 'readonly-tree' });
    expect(rec.input).toMatchObject(INPUT);
  });

  it('re-attach: a fresh daemon (empty registry) rebuilds the in-flight entry from a live job, gate pid included', async () => {
    const q = enqueueJob({ store, kindDef: VERIFY_GATE_JOB_KIND, input: INPUT, codeSha: 'c0de' });
    store.update(q.id, (r) => markClaimed(markLaunching(r, { at: AT }), { at: AT, handle: 'h:1:s', host: 'h', pid: 1, procStart: 's' }));
    writeFileSync(gatePath(dir, q.id), JSON.stringify({ pid: 999, handle: 'h:999:s', gateStartedAt: AT }));
    const logs = [];
    const inFlight = new Map();
    await mk({ log: (m) => logs.push(m) }).sync(inFlight);
    expect(inFlight.get(INPUT.dir)).toMatchObject({ jobId: q.id, pid: 999, runId: 'run-1', sha: 'abc12345', requestStartedAt: INPUT.requestStartedAt });
    expect(logs.some((l) => l.includes('▶ gate started') && l.includes(q.id))).toBe(true);
  });

  it('a finished job is consumed exactly once: verdict logged, entry dropped, timed-out reported as a failure', async () => {
    const q = enqueueJob({ store, kindDef: VERIFY_GATE_JOB_KIND, input: INPUT, codeSha: 'c0de' });
    store.update(q.id, (r) => markSucceeded(markClaimed(markLaunching(r, { at: AT }), { at: AT, handle: 'h:1:s', host: 'h', pid: 1, procStart: 's' }), { at: AT }));
    writeFileSync(resultPath(dir, q.id), JSON.stringify({ outcome: 'timed-out', timedOutPhase: 'gate', marker: { status: 'infrastructure-failure', sha: 'abc12345' } }));
    const logs = [];
    const failures = [];
    const inFlight = new Map([[INPUT.dir, { jobId: q.id, pid: 999 }]]);
    const jobs = mk({ log: (m) => logs.push(m), onSettled: (f) => failures.push(f) });
    await jobs.sync(inFlight);
    await jobs.sync(inFlight);
    expect(inFlight.size).toBe(0);
    expect(logs.filter((l) => l.includes('settled: timed-out'))).toHaveLength(1);
    expect(failures).toEqual([expect.objectContaining({ lane: 3, timedOut: true, timedOutPhase: 'gate' })]);
  });

  it('a finished job whose recorded gate is still alive keeps the lane occupied, so no second gate is queued beside it', async () => {
    const q = enqueueJob({ store, kindDef: VERIFY_GATE_JOB_KIND, input: INPUT, codeSha: 'c0de' });
    store.update(q.id, (r) => markSucceeded(markClaimed(markLaunching(r, { at: AT }), { at: AT, handle: 'h:1:s', host: 'h', pid: 1, procStart: 's' }), { at: AT }));
    writeFileSync(gatePath(dir, q.id), JSON.stringify({ pid: 999, handle: 'h:999:s' }));
    writeFileSync(resultPath(dir, q.id), JSON.stringify({ outcome: 'failed', message: 'previous gate pid 999 survived SIGKILL' }));
    const kill = vi.fn();
    const failures = [];
    const inFlight = new Map();
    const jobs = mk({ kill, onSettled: (f) => failures.push(f) }); // probe stays 'alive'
    await jobs.sync(inFlight);
    await jobs.sync(inFlight);
    expect(inFlight.get(INPUT.dir)).toMatchObject({ jobId: q.id, pid: 999, runId: 'run-1', sha: 'abc12345' });
    expect(kill).toHaveBeenCalledWith(-999, 'SIGKILL'); // each tick retries the kill
    expect(failures).toHaveLength(1); // the failure is still reported exactly once
  });

  it('once that gate is gone the lane is released', async () => {
    const q = enqueueJob({ store, kindDef: VERIFY_GATE_JOB_KIND, input: INPUT, codeSha: 'c0de' });
    store.update(q.id, (r) => markSucceeded(markClaimed(markLaunching(r, { at: AT }), { at: AT, handle: 'h:1:s', host: 'h', pid: 1, procStart: 's' }), { at: AT }));
    writeFileSync(gatePath(dir, q.id), JSON.stringify({ pid: 999, handle: 'h:999:s' }));
    writeFileSync(resultPath(dir, q.id), JSON.stringify({ outcome: 'failed', message: 'x' }));
    let state = 'alive';
    const inFlight = new Map();
    const jobs = mk({ kill: vi.fn(), probe: () => state });
    await jobs.sync(inFlight);
    expect(inFlight.has(INPUT.dir)).toBe(true);
    state = 'dead';
    await jobs.sync(inFlight);
    expect(inFlight.has(INPUT.dir)).toBe(false);
  });

  it('a probe that throws (ps timeout) neither aborts the sync nor kills: the lane is held and the failure still reported', async () => {
    const q = enqueueJob({ store, kindDef: VERIFY_GATE_JOB_KIND, input: INPUT, codeSha: 'c0de' });
    store.update(q.id, (r) => markSucceeded(markClaimed(markLaunching(r, { at: AT }), { at: AT, handle: 'h:1:s', host: 'h', pid: 1, procStart: 's' }), { at: AT }));
    writeFileSync(gatePath(dir, q.id), JSON.stringify({ pid: 999, handle: 'h:999:s' }));
    writeFileSync(resultPath(dir, q.id), JSON.stringify({ outcome: 'failed', message: 'x' }));
    const kill = vi.fn();
    const failures = [];
    const inFlight = new Map();
    const jobs = mk({ kill, probe: () => { throw new Error('ps timed out'); }, onSettled: (f) => failures.push(f) });
    await expect(jobs.sync(inFlight)).resolves.toMatchObject({ live: 1 });
    expect(inFlight.has(INPUT.dir)).toBe(true); // unknown liveness holds the lane (fail closed)
    expect(kill).not.toHaveBeenCalled(); // ...but never signals a pid it cannot prove is still the gate
    expect(failures).toHaveLength(1);
  });

  it('a dead handle is probed once, not on every later tick', async () => {
    const q = enqueueJob({ store, kindDef: VERIFY_GATE_JOB_KIND, input: INPUT, codeSha: 'c0de' });
    store.update(q.id, (r) => markSucceeded(markClaimed(markLaunching(r, { at: AT }), { at: AT, handle: 'h:1:s', host: 'h', pid: 1, procStart: 's' }), { at: AT }));
    writeFileSync(gatePath(dir, q.id), JSON.stringify({ pid: 999, handle: 'h:999:s' }));
    writeFileSync(resultPath(dir, q.id), JSON.stringify({ outcome: 'green' }));
    const probe = vi.fn(() => 'dead');
    const jobs = mk({ probe });
    await jobs.sync(new Map());
    await jobs.sync(new Map());
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('a corrupt sidecar pid (handle says 999, field says 1) never reaches the registry, so a supersede cannot kill(-1)', async () => {
    const q = enqueueJob({ store, kindDef: VERIFY_GATE_JOB_KIND, input: INPUT, codeSha: 'c0de' });
    store.update(q.id, (r) => markSucceeded(markClaimed(markLaunching(r, { at: AT }), { at: AT, handle: 'h:1:s', host: 'h', pid: 1, procStart: 's' }), { at: AT }));
    writeFileSync(gatePath(dir, q.id), JSON.stringify({ pid: 1, handle: 'h:999:s' }));
    writeFileSync(resultPath(dir, q.id), JSON.stringify({ outcome: 'green' }));
    const kill = vi.fn();
    const inFlight = new Map();
    await mk({ kill }).sync(inFlight);
    expect(kill).not.toHaveBeenCalled();
    expect(inFlight.get(INPUT.dir)?.pid ?? null).toBeNull();
  });

  it('a green/red verdict is not a failure; a job the runtime failed (supervisor died twice) is', async () => {
    const green = enqueueJob({ store, kindDef: VERIFY_GATE_JOB_KIND, input: INPUT, codeSha: 'c0de' });
    store.update(green.id, (r) => markSucceeded(r, { at: AT }));
    writeFileSync(resultPath(dir, green.id), JSON.stringify({ outcome: 'green', marker: { status: 'green', sha: 'abc12345' } }));
    const dead = enqueueJob({ store, kindDef: VERIFY_GATE_JOB_KIND, input: { ...INPUT, lane: 4, dir: '/l4' }, codeSha: 'c0de' });
    store.update(dead.id, (r) => markFailed(r, { at: AT, reason: 'handle dead; 2/2 attempts used' }));
    const failures = [];
    const logs = [];
    await mk({ onSettled: (f) => failures.push(f), log: (m) => logs.push(m) }).sync(new Map());
    expect(failures).toEqual([expect.objectContaining({ lane: 4, jobFailed: true })]);
    expect(logs.some((l) => l.includes('settled: green — marker green @ abc12345'))).toBe(true);
  });

  it('a legacy (adopted, pre-job) run keeps its lane — the store never overwrites it', async () => {
    const q = enqueueJob({ store, kindDef: VERIFY_GATE_JOB_KIND, input: INPUT, codeSha: 'c0de' });
    expect(existsSync(join(dir, `${q.id}.json`))).toBe(true);
    const legacy = { runId: 'old', pid: 5, adopted: true };
    const inFlight = new Map([[INPUT.dir, legacy]]);
    await mk().sync(inFlight);
    expect(inFlight.get(INPUT.dir)).toBe(legacy);
  });
});

describe('killGateGroup — only a gate whose handle and pid agree, and an ordinary pid, is ever signalled', () => {
  it('kills the handle\'s group; refuses pid 1, a pid that disagrees with the handle, and a missing or malformed handle', () => {
    const kill = vi.fn();
    expect(killGateGroup({ pid: 999, handle: 'h:999:s' }, kill)).toBe(true);
    expect(kill).toHaveBeenCalledWith(-999, 'SIGKILL');
    kill.mockClear();
    for (const gate of [{ pid: 1, handle: 'h:1:s' }, { pid: 998, handle: 'h:999:s' }, { pid: -1, handle: 'h:999:s' },
      { pid: 999 }, { pid: 999, handle: 'nonsense' }, null]) {
      expect(killGateGroup(gate, kill)).toBe(false);
    }
    expect(kill).not.toHaveBeenCalled();
  });
});
