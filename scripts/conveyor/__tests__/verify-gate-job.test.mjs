/**
 * @file scripts/conveyor/__tests__/verify-gate-job.test.mjs
 * @description #4135 — each verify gate runs as a detached durable job. Covers the pure outcome/ownership rules,
 *   the job child's step (stale request, relaunch over a surviving gate, result + gate sidecar) and the daemon's
 *   store-backed registry (re-attach, consume-once, failure reporting) against a REAL job store in a temp dir.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  classifyGateOutcome, markerStillOurs, runGateStep, createVerifyGateJobs, resolveGateAsJob, killGateGroup,
  gatePath, resultPath, VERIFY_GATE_JOB_KIND, gateState, gateStopHandler,
} from '../verify-gate-job.mjs';
import * as gateJob from '../verify-gate-job.mjs';
import { createJobStore, enqueueJob, hostName, readProcStart } from '../../lib/daemon-jobs-runtime.mjs';
import { formatJobHandle } from '../../operations/job-record.mjs';
import { spawn, execFileSync } from 'node:child_process';
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
      probe: () => (alive ? 'alive' : 'dead'), sleep: async () => {}, pidExists: () => false, groupExists: () => false,
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
      probe: () => { polls += 1; return polls > 3 ? 'dead' : 'alive'; }, sleep: async () => {}, pidExists: () => false, groupExists: () => false,
      laneState: () => ({ marker: running, headSha: 'abc12345' }), runGate });
    expect(runGate).toHaveBeenCalledTimes(1);
    expect(out.outcome).toBe('green');
  });
});

describe('createVerifyGateJobs — the daemon side over a real job store', () => {
  const noReattach = async () => ({ actions: [] });
  const mk = (extra = {}) => createVerifyGateJobs({ store, reattach: noReattach, readHead: () => 'c0de', log: () => {},
    probe: () => 'alive', evict: () => {}, snapshot: {}, groupExists: () => false, ...extra });

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

  it('when the job owning a lane\'s entry ends, another finished job\'s surviving gate takes the lane over in the same sync (PR 4764 round 6)', async () => {
    // A: finished, its gate survives. B: the lane's registry entry (it was live last tick), now finished with no gate.
    const a = enqueueJob({ store, kindDef: VERIFY_GATE_JOB_KIND, input: { ...INPUT, runId: 'run-a' }, codeSha: 'c0de' });
    store.update(a.id, (r) => markFailed(r, { at: AT, reason: 'handle dead; 2/2 attempts used' }));
    writeFileSync(gatePath(dir, a.id), JSON.stringify({ pid: 910, handle: 'h:910:x', runId: 'run-a' }));
    const b = enqueueJob({ store, kindDef: VERIFY_GATE_JOB_KIND, input: { ...INPUT, runId: 'run-b' }, codeSha: 'c0de' });
    store.update(b.id, (r) => markFailed(r, { at: AT, reason: 'refused beside a survivor' }));
    const kill = vi.fn();
    const jobs = mk({ kill, probe: (h) => (h === 'h:910:x' ? 'alive' : 'dead'), pidExists: () => false });
    const inFlight = new Map([[INPUT.dir, { pool: 'we', lane: 3, dir: INPUT.dir, runId: 'run-b', jobId: b.id, pid: null, startedMs: 1 }]]);
    await jobs.sync(inFlight);
    expect(inFlight.get(INPUT.dir)).toMatchObject({ jobId: a.id, runId: 'run-a', pid: 910 }); // never an unheld lane
    expect(inFlight.get(INPUT.dir).startedMs).not.toBe(1); // its own entry, not B's
  });

  it('a job whose record will not parse keeps its lane: an unreadable record is never read as a removed job', async () => {
    const x = enqueueJob({ store, kindDef: VERIFY_GATE_JOB_KIND, input: INPUT, codeSha: 'c0de' });
    writeFileSync(join(dir, `${x.id}.json`), '{"torn');
    const inFlight = new Map([[INPUT.dir, { pool: 'we', lane: 3, dir: INPUT.dir, runId: 'run-1', jobId: x.id, pid: null, startedMs: 1 }]]);
    await mk().sync(inFlight);
    expect(inFlight.get(INPUT.dir)).toMatchObject({ jobId: x.id });
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

describe('fail-closed gate liveness (PR 4764 round 3)', () => {
  const noReattach = async () => ({ actions: [] });
  const mk = (extra = {}) => createVerifyGateJobs({ store, reattach: noReattach, readHead: () => 'c0de', log: () => {},
    probe: () => 'alive', evict: () => {}, snapshot: {}, groupExists: () => false, ...extra });
  const finished = (sidecar) => {
    const q = enqueueJob({ store, kindDef: VERIFY_GATE_JOB_KIND, input: INPUT, codeSha: 'c0de' });
    store.update(q.id, (r) => markSucceeded(markClaimed(markLaunching(r, { at: AT }), { at: AT, handle: 'h:1:s', host: 'h', pid: 1, procStart: 's' }), { at: AT }));
    writeFileSync(gatePath(dir, q.id), JSON.stringify(sidecar));
    writeFileSync(resultPath(dir, q.id), JSON.stringify({ outcome: 'failed', message: 'x' }));
    return q;
  };
  const running = { status: 'running', sha: 'abc12345', startedAt: INPUT.requestStartedAt, suites: 'true' };

  it('a survivor whose liveness is unknown holds the lane with NO pid in the registry, so a superseding dispatch cannot kill it', async () => {
    const q = finished({ pid: 999, handle: 'h:999:s' });
    const kill = vi.fn();
    const inFlight = new Map();
    await mk({ kill, probe: () => { throw new Error('ps timed out'); } }).sync(inFlight);
    expect(inFlight.get(INPUT.dir)).toMatchObject({ jobId: q.id, pid: null });
  });

  it('a survivor with no handle (start time unreadable) or a foreign-host handle holds the lane, is never killed, and releases once provably gone', async () => {
    for (const sidecar of [{ pid: 999, handle: null }, { pid: 999, handle: 'otherhost:999:s' }]) {
      rmSync(dir, { recursive: true, force: true });
      dir = mkdtempSync(join(tmpdir(), 'verify-gate-job-'));
      store = createJobStore(dir);
      finished(sidecar);
      const kill = vi.fn();
      let exists = true;
      const probe = (h) => (String(h).startsWith('otherhost') ? 'foreign' : 'alive');
      const jobs = mk({ kill, probe, pidExists: () => exists });
      const inFlight = new Map();
      await jobs.sync(inFlight);
      expect(inFlight.get(INPUT.dir)).toMatchObject({ pid: null });
      expect(kill).not.toHaveBeenCalled();
      if (sidecar.handle === null) {
        exists = false;
        await jobs.sync(inFlight);
        expect(inFlight.has(INPUT.dir)).toBe(false);
      }
    }
  });

  it('a relaunch refuses to start a gate when the previous gate cannot be proven gone (no handle, foreign host, probe throws) and never kills', async () => {
    const cases = [
      { sidecar: { pid: 780, handle: null }, opts: { pidExists: () => true } },
      { sidecar: { pid: 781, handle: 'otherhost:781:x' }, opts: { probe: () => 'foreign' } },
      { sidecar: { pid: 782, handle: 'h:782:x' }, opts: { probe: () => { throw new Error('ps timed out'); } } },
    ];
    for (const [i, c] of cases.entries()) {
      writeFileSync(gatePath(dir, `u${i}`), JSON.stringify(c.sidecar));
      const kill = vi.fn();
      const runGate = vi.fn();
      const out = await runGateStep({ jobId: `u${i}`, input: INPUT, jobsDir: dir, attempt: 2, log: () => {}, kill, sleep: async () => {},
        laneState: () => ({ marker: running, headSha: 'abc12345' }), runGate, ...c.opts });
      expect(out.outcome).toBe('failed');
      expect(runGate).not.toHaveBeenCalled();
      expect(kill).not.toHaveBeenCalled();
    }
  });

  it('a handle-less sidecar whose pid is gone does not block the relaunch', async () => {
    writeFileSync(gatePath(dir, 'u9'), JSON.stringify({ pid: 783, handle: null }));
    const runGate = vi.fn(async () => {});
    const out = await runGateStep({ jobId: 'u9', input: INPUT, jobsDir: dir, attempt: 2, log: () => {}, pidExists: () => false, groupExists: () => false,
      laneState: () => ({ marker: running, headSha: 'abc12345' }), runGate });
    expect(runGate).toHaveBeenCalledTimes(1);
    expect(out.outcome).toBe('green');
  });
});

describe('a gate is recorded before it is spawned, and found by its run id (PR 4764 round 4)', () => {
  const noReattach = async () => ({ actions: [] });
  const running = { status: 'running', sha: 'abc12345', startedAt: INPUT.requestStartedAt, suites: 'true' };
  const laneState = () => ({ marker: running, headSha: 'abc12345' });
  // The host's process table: the orphaned gate is `node verify-lane.mjs … --run-id=<runId>`.
  const procs = new Map();
  const scan = (runId) => [...procs].filter(([, argv]) => argv.split(' ').includes(`--run-id=${runId}`)).map(([pid]) => pid);
  // Attempt 1 spawns its gate, then its supervisor dies before the gate is recorded (runGate never returns, and
  // onSpawn — where the pid and handle are written — is never reached).
  const dieAfterSpawn = () => {
    procs.set(5150, `node verify-lane.mjs --repo=${INPUT.dir} --json --run-id=${INPUT.runId}`);
    return new Promise(() => {});
  };
  beforeEach(() => procs.clear());

  it('a relaunch never starts a second gate beside a gate its dead supervisor spawned but never recorded', async () => {
    void runGateStep({ jobId: 'w1', input: INPUT, jobsDir: dir, attempt: 1, log: () => {}, laneState, runGate: dieAfterSpawn, scan });
    const runGate = vi.fn(async () => {});
    const kill = vi.fn();
    const out = await runGateStep({ jobId: 'w1', input: INPUT, jobsDir: dir, attempt: 2, log: () => {}, kill, scan,
      sleep: async () => {}, laneState, runGate });
    expect(runGate).not.toHaveBeenCalled(); // the orphan (pid 5150) still runs this request
    expect(out.outcome).toBe('failed');
    expect(kill).not.toHaveBeenCalled(); // no handle: identity is the run id, not proof enough to signal a pid

    procs.clear(); // the orphan's leader exits — but no pid was recorded, so nothing proves its group gone (round 7)
    const again = await runGateStep({ jobId: 'w1', input: INPUT, jobsDir: dir, attempt: 3, log: () => {}, scan, laneState, runGate });
    expect(runGate).not.toHaveBeenCalled();
    expect(again.outcome).toBe('failed');
  });

  it('a finished job whose gate was never recorded holds its lane (no pid) — never released by a run-id scan, only by the operator', async () => {
    const q = enqueueJob({ store, kindDef: VERIFY_GATE_JOB_KIND, input: INPUT, codeSha: 'c0de' });
    void runGateStep({ jobId: q.id, input: INPUT, jobsDir: dir, attempt: 1, log: () => {}, laneState, runGate: dieAfterSpawn, scan });
    store.update(q.id, (r) => markFailed(r, { at: AT, reason: 'handle dead; 2/2 attempts used' }));
    const kill = vi.fn();
    const inFlight = new Map();
    const jobs = createVerifyGateJobs({ store, reattach: noReattach, readHead: () => 'c0de', log: () => {},
      probe: () => 'dead', evict: () => {}, snapshot: {}, kill, scan });
    await jobs.sync(inFlight);
    expect(inFlight.get(INPUT.dir)).toMatchObject({ jobId: q.id, pid: null });
    expect(kill).not.toHaveBeenCalled();
    procs.clear();
    await jobs.sync(inFlight);
    expect(inFlight.get(INPUT.dir)).toMatchObject({ jobId: q.id, pid: null }); // still held: a pending record proves nothing gone
    expect(jobs.laneHeld(INPUT.dir)).toMatch(/may still run/);
    // The operator, having checked the gate is gone, releases the lane: its claim and the record that held it.
    expect(gateJob.releaseLaneByOperator({ jobsDir: dir, dir: INPUT.dir, deps: { probe: () => 'dead' } })).toMatchObject({ setAside: [q.id] });
    await jobs.sync(inFlight);
    expect(inFlight.has(INPUT.dir)).toBe(false);
    expect(jobs.laneHeld(INPUT.dir)).toBeNull();
  });

  it('a sidecar the supervisor cannot write means no gate is started at all', async () => {
    const runGate = vi.fn(async () => {});
    const out = await runGateStep({ jobId: 'w3', input: INPUT, jobsDir: join(dir, 'missing-dir'), log: () => {}, scan, laneState, runGate })
      .catch((e) => ({ outcome: `threw: ${e.message}` }));
    expect(runGate).not.toHaveBeenCalled();
    expect(out.outcome).not.toBe('green');
  });
});

describe('a gate is its whole process group, not just its leader (PR 4764 round 4)', () => {
  const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (cond, ms = 10_000) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleepMs(50)) if (cond()) return;
    throw new Error('timed out waiting');
  };
  const groupMembers = (pgid) => execFileSync('ps', ['-axo', 'pid=,pgid='], { encoding: 'utf8' }).split('\n')
    .map((l) => l.trim().split(/\s+/).map(Number)).filter(([p, g]) => g === pgid && p).length;

  it('a recorded gate whose pid is gone but whose group still exists reads unknown, handle or not', () => {
    expect(gateState({ pid: 4242, handle: null }, { pidExists: () => false, groupExists: () => true })).toBe('unknown');
    const gone = { probe: () => 'dead', pidExists: () => false };
    expect(gateState({ pid: 4242, handle: 'h:4242:s' }, { ...gone, groupExists: () => true })).toBe('unknown');
    expect(gateState({ pid: 4242, handle: 'h:4242:s' }, { ...gone, groupExists: () => { throw new Error('EPERM?'); } })).toBe('unknown');
    expect(gateState({ pid: 4242, handle: 'h:4242:s' }, { ...gone, groupExists: () => false })).toBe('dead');
    // The leader's pid already belongs to another process: our group cannot still exist, whatever group -4242 is.
    expect(gateState({ pid: 4242, handle: 'h:4242:s' }, { probe: () => 'dead', pidExists: () => true, groupExists: () => true })).toBe('dead');
    expect(gateState({ pid: 4242, handle: null }, { pidExists: () => false, groupExists: () => false })).toBe('dead');
  });

  it('real processes: the leader dies while its test-runner child runs on — not dead until the whole group is gone', async () => {
    const childJs = "setTimeout(() => {}, 60000)";
    const leader = spawn(process.execPath, ['-e',
      `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childJs)}], { stdio: 'ignore' }); ${childJs}`],
    { detached: true, stdio: 'ignore' });
    const exited = new Promise((r) => leader.once('exit', r));
    const pid = leader.pid;
    try {
      await waitFor(() => groupMembers(pid) >= 2);
      const gate = { pid, handle: formatJobHandle({ host: hostName(), pid, procStart: readProcStart(pid) }) };
      expect(gateState(gate)).toBe('alive');
      process.kill(pid, 'SIGKILL'); // the leader alone (OOM, crash): its child keeps running in the group
      await exited;
      expect(groupMembers(pid)).toBeGreaterThanOrEqual(1);
      expect(gateState(gate)).toBe('unknown'); // a retry must not start a second gate beside the surviving child
      process.kill(-pid, 'SIGKILL');
      await waitFor(() => groupMembers(pid) === 0);
      expect(gateState(gate)).toBe('dead');
    } finally {
      try { process.kill(-pid, 'SIGKILL'); } catch {}
    }
  }, 20_000);

});

describe('a handle-less sidecar is proven gone only by its pid not existing (PR 4764 round 7)', () => {
  it('pid exists: unknown whatever an argv scan says (no start time, so no identity); pid gone and group gone: dead', () => {
    const gate = { pid: 4242, handle: null, runId: 'run-1' };
    expect(gateState(gate, { pidExists: () => true, groupExists: () => false })).toBe('unknown');
    expect(gateState(gate, { pidExists: () => { throw new Error('EPERM?'); }, groupExists: () => false })).toBe('unknown');
    expect(gateState(gate, { pidExists: () => false, groupExists: () => false })).toBe('dead');
    expect(gateState({ ...gate, pid: 1 }, { pidExists: () => false, groupExists: () => false })).toBe('unknown');
  });
});

describe('stopping gate jobs (restartInFlight: kill) and the supervisor stop handler (PR 4764 round 4)', () => {
  const noReattach = async () => ({ actions: [] });
  it('stopAll stops each live supervisor, then kills its gate group only if a probe AFTER the stop proves it alive', async () => {
    const running = (input) => {
      const q = enqueueJob({ store, kindDef: VERIFY_GATE_JOB_KIND, input, codeSha: 'c0de' });
      store.update(q.id, (r) => markClaimed(markLaunching(r, { at: AT }), { at: AT, handle: `h:${input.lane}00:s`, host: 'h', pid: Number(`${input.lane}00`), procStart: 's' }));
      return q;
    };
    const a = running(INPUT);
    const b = running({ ...INPUT, lane: 4, dir: '/l4' });
    writeFileSync(gatePath(dir, a.id), JSON.stringify({ pid: 901, handle: 'h:901:s' }));
    writeFileSync(gatePath(dir, b.id), JSON.stringify({ pid: 902, handle: 'h:902:s' }));
    const stopped = new Set();
    const stop = vi.fn(async (handle) => { stopped.add(handle); });
    // a's supervisor takes its gate down when stopped; b's gate survives the stop.
    const probe = (h) => (h === 'h:901:s' && stopped.has('h:300:s') ? 'dead' : 'alive');
    const kill = vi.fn();
    const jobs = createVerifyGateJobs({ store, reattach: noReattach, readHead: () => 'c0de', log: () => {}, probe, evict: () => {},
      snapshot: {}, pidExists: () => false, groupExists: () => false });
    await jobs.stopAll({ stop, kill });
    expect(stop).toHaveBeenCalledWith('h:300:s');
    expect(stop).toHaveBeenCalledWith('h:400:s');
    expect(kill).not.toHaveBeenCalledWith(-901, 'SIGKILL');
    expect(kill).toHaveBeenCalledWith(-902, 'SIGKILL');
  });

  it('the supervisor stop handler kills the gate group captured at spawn (before its sidecar write), and only an ordinary pid', async () => {
    let pid = null;
    const kill = vi.fn();
    const exit = vi.fn();
    const handler = gateStopHandler({ getPid: () => pid, kill, exit });
    handler(); // stopped before any gate spawned
    expect(kill).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(143);
    // The sidecar write after the spawn fails (the path is now a non-empty directory) — the handler still knows the pid.
    const running = { status: 'running', sha: 'abc12345', startedAt: INPUT.requestStartedAt, suites: 'true' };
    const gateKill = vi.fn(); // the step's own kill of a gate it could not record (round 5) — never a real signal here
    const out = await runGateStep({ jobId: 'sig', input: INPUT, jobsDir: dir, log: () => {}, laneState: () => ({ marker: running, headSha: 'abc12345' }),
      readStart: () => 's', onGate: (p) => { pid = p; }, kill: gateKill, scanLane: () => [],
      runGate: async (o) => {
        rmSync(gatePath(dir, 'sig'), { force: true });
        mkdirSync(join(gatePath(dir, 'sig'), 'blocker'), { recursive: true });
        try { o.onSpawn(4243); } catch {}
      } });
    expect(out.outcome).toBe('failed'); // the write failed
    expect(gateKill).toHaveBeenCalledWith(-4243, 'SIGKILL');
    handler();
    expect(kill).toHaveBeenCalledWith(-4243, 'SIGKILL');
    pid = 1;
    kill.mockClear();
    handler();
    expect(kill).not.toHaveBeenCalled();
  });
});

describe('a superseded gate job is killed only after a fresh probe (PR 4764 round 4)', () => {
  const noReattach = async () => ({ actions: [] });
  it('killJobGate re-reads the sidecar and signals only a gate whose handle still proves it alive', async () => {
    const q = enqueueJob({ store, kindDef: VERIFY_GATE_JOB_KIND, input: INPUT, codeSha: 'c0de' });
    writeFileSync(gatePath(dir, q.id), JSON.stringify({ pid: 999, handle: 'h:999:s' }));
    let state = 'alive';
    const kill = vi.fn();
    const jobs = createVerifyGateJobs({ store, reattach: noReattach, readHead: () => 'c0de', log: () => {},
      probe: () => state, evict: () => {}, snapshot: {}, kill, pidExists: () => false, groupExists: () => false });
    const inFlight = new Map();
    await jobs.sync(inFlight);
    const entry = inFlight.get(INPUT.dir);
    expect(entry.pid).toBe(999); // proven alive at sync time
    state = 'dead'; // ...but the gate exits (and its pid may be reused) before the dispatch supersedes it
    expect(jobs.killJobGate(entry)).toBe(false);
    state = 'unknown';
    expect(jobs.killJobGate(entry)).toBe(false);
    expect(kill).not.toHaveBeenCalled();
    state = 'alive';
    expect(jobs.killJobGate(entry)).toBe(true);
    expect(kill).toHaveBeenCalledWith(-999, 'SIGKILL');
  });
});

describe('no gate record is ever missing or reduced while its gate runs, and no gate starts beside another on its lane (PR 4764 round 5)', () => {
  const running = { status: 'running', sha: 'abc12345', startedAt: INPUT.requestStartedAt, suites: 'true' };
  const laneState = () => ({ marker: running, headSha: 'abc12345' });
  const quiet = { log: () => {}, laneState, scanLane: () => [], sleep: async () => {} };

  it('gate start never reduces the record to a timestamp when the sidecar cannot be read back', async () => {
    const runGate = vi.fn(async (o) => {
      o.onSpawn(4243);
      writeFileSync(gatePath(dir, 'r1'), '{"pid":42'); // an unreadable read-back (torn by another writer, EMFILE…)
      o.onGateStarted();
    });
    await runGateStep({ jobId: 'r1', input: INPUT, jobsDir: dir, runGate, ...quiet, readStart: () => 'Sat Oct 10 10:00:00 2026' });
    const gate = JSON.parse(readFileSync(gatePath(dir, 'r1'), 'utf8'));
    expect(gate).toMatchObject({ pid: 4243, runId: 'run-1' });
    expect(gate.handle).toMatch(/:4243:/);
    expect(gate.gateStartedAt).toBeTruthy();
  });

  it('the pid is on disk before the start-time read, so a supervisor that dies inside it leaves a findable group', async () => {
    let seen = null;
    const runGate = vi.fn(async (o) => { o.onSpawn(4245); });
    await runGateStep({ jobId: 'r2', input: INPUT, jobsDir: dir, runGate, ...quiet,
      readStart: () => { seen = JSON.parse(readFileSync(gatePath(dir, 'r2'), 'utf8')); return 'Sat Oct 10 10:00:00 2026'; } });
    expect(seen).toMatchObject({ pid: 4245, runId: 'run-1' });
    expect(seen.pending).toBeFalsy();
  });

  it('a gate whose pid cannot be recorded is killed at once and the run fails — never left running unrecorded', async () => {
    const kill = vi.fn();
    const runGate = vi.fn(async (o) => {
      rmSync(gatePath(dir, 'r3'), { force: true });
      mkdirSync(gatePath(dir, 'r3')); // the record can no longer be written
      try { o.onSpawn(4244); } catch {} // runLaneGate swallows an onSpawn throw, exactly like this
    });
    const out = await runGateStep({ jobId: 'r3', input: INPUT, jobsDir: dir, runGate, kill, ...quiet, readStart: () => 'x' });
    expect(kill).toHaveBeenCalledWith(-4244, 'SIGKILL');
    expect(out.outcome).toBe('failed');
    expect(JSON.parse(readFileSync(resultPath(dir, 'r3'), 'utf8')).message).toMatch(/could not record/);
  });

  it('another job\'s surviving gate on the same lane refuses the start (and is never killed from here); it runs once that gate is gone', async () => {
    const a = enqueueJob({ store, kindDef: VERIFY_GATE_JOB_KIND, input: { ...INPUT, runId: 'run-0' }, codeSha: 'c0de' });
    store.update(a.id, (r) => markFailed(r, { at: AT, reason: 'handle dead; 2/2 attempts used' }));
    writeFileSync(gatePath(dir, a.id), JSON.stringify({ pid: 900, handle: 'h:900:x', runId: 'run-0' }));
    const other = enqueueJob({ store, kindDef: VERIFY_GATE_JOB_KIND, input: { ...INPUT, dir: '/lanes/we/lane-9', runId: 'run-9' }, codeSha: 'c0de' });
    writeFileSync(gatePath(dir, other.id), JSON.stringify({ pid: 901, handle: 'h:901:x', runId: 'run-9' }));
    let aAlive = 'alive';
    const probe = (h) => (h === 'h:900:x' ? aAlive : 'alive');
    const runGate = vi.fn(async () => {});
    const kill = vi.fn();
    const deps = { ...quiet, probe, kill, pidExists: () => false, groupExists: () => false };
    const out = await runGateStep({ jobId: 'b1', input: INPUT, jobsDir: dir, runGate, ...deps });
    expect(runGate).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
    expect(out.outcome).toBe('failed');
    expect(JSON.parse(readFileSync(resultPath(dir, 'b1'), 'utf8')).message).toContain(a.id);
    aAlive = 'unknown'; // liveness unknown is not gone
    expect((await runGateStep({ jobId: 'b2', input: INPUT, jobsDir: dir, runGate, ...deps })).outcome).toBe('failed');
    aAlive = 'dead'; // gone — and a live gate on ANOTHER lane never blocks this one
    expect((await runGateStep({ jobId: 'b3', input: INPUT, jobsDir: dir, runGate, ...deps })).outcome).toBe('green');
    expect(runGate).toHaveBeenCalledTimes(1);
  });

  it('another job\'s pending record refuses the start whatever its clock says, finished or not; the refused job stops pending and releases its claim', async () => {
    const peer = enqueueJob({ store, kindDef: VERIFY_GATE_JOB_KIND, input: { ...INPUT, runId: 'run-p' }, codeSha: 'c0de' }); // unfinished
    const runGate = vi.fn(async () => {});
    for (const at of ['2000-01-01T00:00:00.000Z', '2999-01-01T00:00:00.000Z']) {
      writeFileSync(gatePath(dir, peer.id), JSON.stringify({ pid: null, handle: null, pending: true, runId: 'run-p', dir: INPUT.dir, at }));
      expect((await runGateStep({ jobId: `c${at.slice(0, 4)}`, input: INPUT, jobsDir: dir, runGate, ...quiet })).outcome).toBe('failed');
    }
    expect(existsSync(gatePath(dir, 'c2000'))).toBe(false); // refused before it recorded anything: nobody waits on it
    expect(gateJob.readLaneClaim(dir, INPUT.dir)).toMatchObject({ released: true });
    store.update(peer.id, (r) => markFailed(r, { at: AT, reason: 'gave up' }));
    expect((await runGateStep({ jobId: 'c3', input: INPUT, jobsDir: dir, runGate, ...quiet })).outcome).toBe('failed'); // finished: still no pid, never proven gone
    expect(runGate).not.toHaveBeenCalled();
  });

  it('the lane claim on a real filesystem: exactly one of several claimers wins; it passes over only once its holder is proven gone', () => {
    const holder = (jobId) => ({ jobId, runId: `run-${jobId}`, dir: INPUT.dir, attempt: 1, supervisor: `h:${jobId.length}00:s` });
    let gone = false;
    const results = ['a', 'bb', 'ccc'].map((id) => gateJob.claimLane({ jobsDir: dir, dir: INPUT.dir, holder: holder(id),
      holderGone: () => gone || 'held' }));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.slice(1).map((r) => r.why)).toEqual(['held', 'held']);
    expect(gateJob.readLaneClaim(dir, INPUT.dir)).toMatchObject({ seq: 1, claim: { jobId: 'a' }, released: false });
    gone = true;
    expect(gateJob.claimLane({ jobsDir: dir, dir: `${INPUT.dir}/`, holder: holder('bb'), holderGone: () => gone })).toMatchObject({ ok: true, seq: 2 });
    // A torn claim file is never "no claim".
    writeFileSync(join(dir, gateJob.LANE_CLAIM_DIR, `${gateJob.laneKey(INPUT.dir)}.00000003.claim`), '{"jobId":');
    expect(gateJob.claimLane({ jobsDir: dir, dir: INPUT.dir, holder: holder('ccc'), holderGone: () => true })).toMatchObject({ ok: false, why: expect.stringMatching(/cannot be read/) });
  });

  it('claimHolderGone: only a supervisor proven dead by pid + start time AND a gate proven gone (or never recorded) pass a claim on', () => {
    const claim = { jobId: 'h1', supervisor: 'h:500:s' };
    const deps = { pidExists: () => false, groupExists: () => false };
    expect(gateJob.claimHolderGone(claim, dir, { ...deps, probe: () => 'alive' })).toMatch(/supervisor is running/);
    expect(gateJob.claimHolderGone(claim, dir, { ...deps, probe: () => 'foreign' })).toMatch(/cannot be proven gone/);
    expect(gateJob.claimHolderGone({ ...claim, supervisor: 'garbage' }, dir, { ...deps, probe: () => 'dead' })).toMatch(/cannot be proven gone/);
    expect(gateJob.claimHolderGone(claim, dir, { ...deps, probe: () => { throw new Error('ps timed out'); } })).toMatch(/cannot be proven gone/);
    expect(gateJob.claimHolderGone(claim, dir, { ...deps, probe: () => 'dead' })).toBe(true); // no gate was ever recorded
    writeFileSync(gatePath(dir, 'h1'), '{"pid":');
    expect(gateJob.claimHolderGone(claim, dir, { ...deps, probe: () => 'dead' })).toMatch(/unreadable/);
    writeFileSync(gatePath(dir, 'h1'), JSON.stringify({ pid: 600, handle: 'h:600:s' }));
    expect(gateJob.claimHolderGone(claim, dir, { ...deps, probe: (h) => (h === 'h:600:s' ? 'alive' : 'dead') })).toMatch(/may still run/);
    expect(gateJob.claimHolderGone(claim, dir, { ...deps, probe: () => 'dead' })).toBe(true);
  });

  it('an unreadable job record holds only the lane its sidecar names, never every lane', async () => {
    const bad = enqueueJob({ store, kindDef: VERIFY_GATE_JOB_KIND, input: INPUT, codeSha: 'c0de' });
    writeFileSync(join(dir, `${bad.id}.json`), '{"not a job record');
    writeFileSync(gatePath(dir, bad.id), JSON.stringify({ pid: 902, handle: 'h:902:x', runId: 'run-b', dir: '/lanes/we/lane-9' }));
    const runGate = vi.fn(async () => {});
    const deps = { ...quiet, probe: () => 'unknown' };
    expect((await runGateStep({ jobId: 'k1', input: INPUT, jobsDir: dir, runGate, ...deps })).outcome).toBe('green');
    writeFileSync(gatePath(dir, bad.id), JSON.stringify({ pid: 902, handle: 'h:902:x', runId: 'run-b', dir: INPUT.dir }));
    expect((await runGateStep({ jobId: 'k2', input: INPUT, jobsDir: dir, runGate, ...deps })).outcome).toBe('failed');
    expect(runGate).toHaveBeenCalledTimes(1);
  });

  it('a gate no sidecar names at all (another daemon, a rolled-back in-process sweep) refuses the start; a failed scan does too', async () => {
    const runGate = vi.fn(async () => {});
    const out = await runGateStep({ jobId: 'n1', input: INPUT, jobsDir: dir, runGate, ...quiet, scanLane: () => [6001] });
    expect(runGate).not.toHaveBeenCalled();
    expect(out.outcome).toBe('failed');
    expect(JSON.parse(readFileSync(resultPath(dir, 'n1'), 'utf8')).message).toMatch(/6001/);
    const failed = await runGateStep({ jobId: 'n2', input: INPUT, jobsDir: dir, runGate, ...quiet, scanLane: () => { throw new Error('ps timed out'); } });
    expect(failed.outcome).toBe('failed');
    expect(runGate).not.toHaveBeenCalled();
  });

});

describe('a new gate starts on a lane only once the previous one is CONFIRMED gone (PR 4764 round 7, operator ruling)', () => {
  const running = { status: 'running', sha: 'abc12345', startedAt: INPUT.requestStartedAt, suites: 'true' };
  const laneState = () => ({ marker: running, headSha: 'abc12345' });
  // The claim's supervisor is this test (alive); any recorded gate handle is dead and its group gone unless a case says otherwise.
  const deps = { log: () => {}, laneState, scanLane: () => [], sleep: async () => {}, supervisorHandle: () => 'h:77:s',
    probe: (h) => (h === 'h:77:s' ? 'alive' : 'dead'), pidExists: () => false, groupExists: () => false, scan: () => [] };
  const noReattach = async () => ({ actions: [] });
  const mk = (extra = {}) => createVerifyGateJobs({ store, reattach: noReattach, readHead: () => 'c0de', log: () => {},
    probe: () => 'dead', evict: () => {}, snapshot: {}, pidExists: () => false, groupExists: () => false, scan: () => [], kill: vi.fn(), ...extra });
  const finishedJob = (input = INPUT) => {
    const q = enqueueJob({ store, kindDef: VERIFY_GATE_JOB_KIND, input, codeSha: 'c0de' });
    store.update(q.id, (r) => markFailed(r, { at: AT, reason: 'handle dead; 2/2 attempts used' }));
    return q;
  };
  const TORN = ['{"pid":9', '', '[]', '"x"'];

  it('finding 1 — an unreadable gate sidecar is "possibly running", never "no gate": a relaunch, a peer job and the tick all hold the lane', async () => {
    for (const [i, text] of TORN.entries()) {
      // the job's own previous attempt
      writeFileSync(gatePath(dir, `own${i}`), text);
      const runGate = vi.fn(async () => {});
      expect((await runGateStep({ jobId: `own${i}`, input: INPUT, jobsDir: dir, attempt: 2, runGate, ...deps })).outcome).toBe('failed');
      // another (finished) job of this lane
      const peer = finishedJob({ ...INPUT, runId: `run-p${i}` });
      writeFileSync(gatePath(dir, peer.id), text);
      expect((await runGateStep({ jobId: `new${i}`, input: INPUT, jobsDir: dir, runGate, ...deps })).outcome).toBe('failed');
      expect(runGate).not.toHaveBeenCalled();
      // the tick: the finished job's lane stays held, and nothing is signalled
      const inFlight = new Map();
      const kill = vi.fn();
      await mk({ kill }).sync(inFlight);
      expect(inFlight.get(INPUT.dir)).toMatchObject({ pid: null });
      expect(kill).not.toHaveBeenCalled();
      rmSync(dir, { recursive: true, force: true });
      dir = mkdtempSync(join(tmpdir(), 'verify-gate-job-'));
      store = createJobStore(dir);
    }
  });

  it('finding 2 — a retry never starts beside a previous gate that is not proven gone by pid + start time', async () => {
    const runGate = vi.fn(async () => {});
    // The handle-less pid still exists (no start time recorded): an argv scan is not identity proof.
    writeFileSync(gatePath(dir, 'r1'), JSON.stringify({ pid: 4321, handle: null, runId: 'run-1' }));
    expect((await runGateStep({ jobId: 'r1', input: INPUT, jobsDir: dir, attempt: 2, runGate, ...deps, pidExists: () => true })).outcome).toBe('failed');
    // A gate recorded only as pending (its supervisor died around the spawn): no pid, so never provably gone.
    writeFileSync(gatePath(dir, 'r2'), JSON.stringify({ pid: null, handle: null, pending: true, runId: 'run-1', dir: INPUT.dir, at: AT }));
    expect((await runGateStep({ jobId: 'r2', input: INPUT, jobsDir: dir, attempt: 2, runGate, ...deps })).outcome).toBe('failed');
    expect(runGate).not.toHaveBeenCalled();
    // ...and the tick keeps that finished job's lane held rather than releasing it once no process carries the run id.
    const q = finishedJob();
    writeFileSync(gatePath(dir, q.id), JSON.stringify({ pid: null, handle: null, pending: true, runId: 'run-1', dir: INPUT.dir, at: AT }));
    const inFlight = new Map();
    await mk().sync(inFlight);
    await mk().sync(inFlight);
    expect(inFlight.get(INPUT.dir)).toMatchObject({ jobId: q.id, pid: null });
  });

  it('finding 3 — a malformed or foreign handle, or an unrecognised record, is unknown (held, never killed)', async () => {
    const opts = { probe: () => 'dead', pidExists: () => false, groupExists: () => false, scan: () => [] };
    expect(gateState({ pid: 999, handle: 'garbage' }, opts)).toBe('unknown');
    expect(gateState({ pid: null, handle: null, runId: 'run-1' }, opts)).toBe('unknown');
    expect(gateState({ pid: 'x' }, opts)).toBe('unknown');
    expect(gateState({ pid: 999, handle: 'otherhost:999:s' }, { ...opts, probe: () => 'foreign' })).toBe('unknown');
    const q = finishedJob();
    writeFileSync(gatePath(dir, q.id), JSON.stringify({ pid: 999, handle: 'garbage', runId: 'run-1' }));
    const kill = vi.fn();
    const inFlight = new Map();
    await mk({ kill }).sync(inFlight);
    expect(inFlight.get(INPUT.dir)).toMatchObject({ jobId: q.id, pid: null });
    expect(kill).not.toHaveBeenCalled();
    const runGate = vi.fn(async () => {});
    expect((await runGateStep({ jobId: 'm1', input: INPUT, jobsDir: dir, runGate, ...deps })).outcome).toBe('failed');
    expect(runGate).not.toHaveBeenCalled();
  });

  it('finding 4 — rollback mode launches no new gate supervisor (queued or relaunched): only the in-process sweep starts gates', async () => {
    const reattach = vi.fn(async () => ({ actions: [] }));
    await mk({ reattach, launchJobs: false }).sync(new Map());
    const launch = reattach.mock.calls[0][0].launch;
    expect(typeof launch).toBe('function');
    expect(launch({ store, id: 'x' })).toBeNull();
  });

  it('finding 5 — two jobs on one lane: the one that records second never spawns, whatever its clock said (claim before spawn)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      let release;
      const holding = new Promise((r) => { release = r; });
      const runGate = vi.fn(() => holding); // B is about to spawn: its record is still pending
      vi.setSystemTime(new Date('2026-10-10T12:00:01.000Z'));
      const b = runGateStep({ jobId: 'jb', input: { ...INPUT, runId: 'run-b' }, jobsDir: dir, runGate, ...deps });
      for (let i = 0; i < 50 && runGate.mock.calls.length === 0; i += 1) await new Promise((r) => setImmediate(r));
      expect(runGate).toHaveBeenCalledTimes(1);
      // A read its clock FIRST (an earlier `at`) but records second: ordering by `at` would let both spawn.
      vi.setSystemTime(new Date('2026-10-10T12:00:00.000Z'));
      const a = await runGateStep({ jobId: 'ja', input: { ...INPUT, runId: 'run-a' }, jobsDir: dir, runGate, ...deps });
      expect(a.outcome).toBe('failed');
      expect(runGate).toHaveBeenCalledTimes(1);
      release();
      await b;
    } finally { vi.useRealTimers(); }
  });
});

describe('round 7 self-review: proof kept, rollback orphans stopped, release guarded, one lane spelling (PR 4764)', () => {
  const running = { status: 'running', sha: 'abc12345', startedAt: INPUT.requestStartedAt, suites: 'true' };
  const laneState = () => ({ marker: running, headSha: 'abc12345' });
  const noReattach = async () => ({ actions: [] });
  const mk = (extra = {}) => createVerifyGateJobs({ store, reattach: noReattach, readHead: () => 'c0de', log: () => {},
    probe: () => 'dead', evict: () => {}, snapshot: {}, pidExists: () => false, groupExists: () => false, kill: vi.fn(), ...extra });

  it('M1 — a gate once proven gone stays gone when its pid is later reused (the proof is written down)', async () => {
    const q = enqueueJob({ store, kindDef: VERIFY_GATE_JOB_KIND, input: INPUT, codeSha: 'c0de' });
    store.update(q.id, (r) => markFailed(r, { at: AT, reason: 'x' }));
    writeFileSync(gatePath(dir, q.id), JSON.stringify({ pid: 4321, handle: null, runId: 'run-1' })); // start time was unreadable
    let reused = false;
    const soon = () => Date.parse(AT) + 60_000; // inside the keep window: the finished job's files are not pruned yet
    const jobs = mk({ pidExists: () => reused, now: soon });
    const inFlight = new Map();
    await jobs.sync(inFlight);
    expect(inFlight.has(INPUT.dir)).toBe(false);
    expect(JSON.parse(readFileSync(gatePath(dir, q.id), 'utf8'))).toMatchObject({ pid: 4321, gone: true });
    reused = true; // pid 4321 now belongs to an unrelated process
    await mk({ pidExists: () => reused, now: soon }).sync(inFlight);
    expect(inFlight.has(INPUT.dir)).toBe(false);
    // ...and a new job on the lane is not refused by that record either.
    expect((await runGateStep({ jobId: 'n1', input: INPUT, jobsDir: dir, runGate: vi.fn(async () => {}), log: () => {}, laneState,
      scanLane: () => [], pidExists: () => true, groupExists: () => false, supervisorHandle: () => 'h:77:s', probe: () => 'dead' })).outcome).toBe('green');
  });

  it('M2 — rollback: a requeued job (its supervisor died) whose gate still runs holds the lane and that gate is killed each tick', async () => {
    const q = enqueueJob({ store, kindDef: VERIFY_GATE_JOB_KIND, input: INPUT, codeSha: 'c0de' }); // queued, attempt 1 gone
    writeFileSync(gatePath(dir, q.id), JSON.stringify({ pid: 990, handle: 'h:990:s', runId: 'run-1' }));
    let state = 'alive';
    const kill = vi.fn();
    const jobs = mk({ launchJobs: false, kill, probe: () => state });
    const inFlight = new Map();
    await jobs.sync(inFlight);
    await jobs.sync(inFlight);
    expect(inFlight.get(INPUT.dir)).toMatchObject({ jobId: q.id, pid: 990 });
    expect(kill).toHaveBeenCalledTimes(2);
    state = 'dead';
    await jobs.sync(inFlight);
    expect(inFlight.has(INPUT.dir)).toBe(false); // a queued job with no running gate holds nothing in rollback
  });

  it('M3 — a refusal by the backstop records no pending gate (the slow scan runs before the record)', async () => {
    let seenDuringScan;
    const out = await runGateStep({ jobId: 's1', input: INPUT, jobsDir: dir, runGate: vi.fn(), log: () => {}, laneState,
      supervisorHandle: () => 'h:77:s', scanLane: () => { seenDuringScan = existsSync(gatePath(dir, 's1')); return [6001]; } });
    expect(out.outcome).toBe('failed');
    expect(seenDuringScan).toBe(false);
    expect(existsSync(gatePath(dir, 's1'))).toBe(false);
    expect(gateJob.readLaneClaim(dir, INPUT.dir)).toMatchObject({ released: true });
  });

  it('M4 — release-lane never overrides proof: it refuses while the claim\'s supervisor or a gate is proven alive, and sets aside only unknown records', () => {
    const q = enqueueJob({ store, kindDef: VERIFY_GATE_JOB_KIND, input: INPUT, codeSha: 'c0de' });
    gateJob.claimLane({ jobsDir: dir, dir: INPUT.dir, holder: { jobId: q.id, runId: 'run-1', dir: INPUT.dir, supervisor: 'h:5:s' }, holderGone: () => true });
    writeFileSync(gatePath(dir, q.id), JSON.stringify({ pid: null, handle: null, pending: true, runId: 'run-1', dir: INPUT.dir }));
    const alive = gateJob.releaseLaneByOperator({ jobsDir: dir, dir: INPUT.dir, deps: { probe: () => 'alive' } });
    expect(alive.refused).toMatch(/supervisor is running/);
    expect(gateJob.readLaneClaim(dir, INPUT.dir).released).toBe(false);
    const other = enqueueJob({ store, kindDef: VERIFY_GATE_JOB_KIND, input: { ...INPUT, runId: 'run-2' }, codeSha: 'c0de' });
    writeFileSync(gatePath(dir, other.id), JSON.stringify({ pid: 800, handle: 'h:800:s', runId: 'run-2' }));
    const probe = (h) => (h === 'h:800:s' ? 'alive' : 'dead');
    expect(gateJob.releaseLaneByOperator({ jobsDir: dir, dir: INPUT.dir, deps: { probe } }).refused).toMatch(/proven alive/);
    expect(JSON.parse(readFileSync(gatePath(dir, other.id), 'utf8')).handle).toBe('h:800:s'); // untouched
    const ok = gateJob.releaseLaneByOperator({ jobsDir: dir, dir: `${INPUT.dir}/`, deps: { probe: () => 'dead', pidExists: () => false, groupExists: () => false } });
    expect(ok).toMatchObject({ claim: 1, setAside: [q.id] });
  });

  it('M6 — two spellings of one lane (a symlink, a trailing slash) are one lane: one claim, one peer check', async () => {
    const real = join(dir, 'pool', 'lane-3');
    mkdirSync(real, { recursive: true });
    const link = join(dir, 'pool-link');
    symlinkSync(join(dir, 'pool'), link);
    const alias = join(link, 'lane-3');
    expect(gateJob.laneKey(alias)).toBe(gateJob.laneKey(real));
    expect(gateJob.laneKey(`${real}/`)).toBe(gateJob.laneKey(real));
    // A peer job recorded under the real spelling holds the lane for a job dispatched under the symlinked one.
    const peer = enqueueJob({ store, kindDef: VERIFY_GATE_JOB_KIND, input: { ...INPUT, dir: real, runId: 'run-p' }, codeSha: 'c0de' });
    store.update(peer.id, (r) => markFailed(r, { at: AT, reason: 'x' }));
    writeFileSync(gatePath(dir, peer.id), JSON.stringify({ pid: 4000, handle: 'h:4000:s', runId: 'run-p', dir: real }));
    const runGate = vi.fn(async () => {});
    const out = await runGateStep({ jobId: 'al', input: { ...INPUT, dir: alias }, jobsDir: dir, runGate, log: () => {}, laneState,
      scanLane: () => [], supervisorHandle: () => 'h:77:s', probe: (h) => (h === 'h:4000:s' ? 'alive' : 'dead') });
    expect(out.outcome).toBe('failed');
    expect(runGate).not.toHaveBeenCalled();
  });

  it('claimLane: a create that loses the race (EEXIST) judges the winner\'s claim instead of overwriting it', () => {
    const key = gateJob.laneKey(INPUT.dir);
    let calls = 0;
    const holderGone = () => {
      calls += 1;
      if (calls === 1) { // between our read and our create, another job takes the next number
        writeFileSync(join(dir, gateJob.LANE_CLAIM_DIR, `${key}.00000002.claim`), JSON.stringify({ jobId: 'winner', supervisor: 'h:9:s' }));
        return true;
      }
      return 'the winner holds it';
    };
    gateJob.claimLane({ jobsDir: dir, dir: INPUT.dir, holder: { jobId: 'first', supervisor: 'h:1:s' }, holderGone: () => true });
    const out = gateJob.claimLane({ jobsDir: dir, dir: INPUT.dir, holder: { jobId: 'loser', supervisor: 'h:2:s' }, holderGone });
    expect(out).toEqual({ ok: false, why: 'the winner holds it' });
    expect(gateJob.readLaneClaim(dir, INPUT.dir)).toMatchObject({ seq: 2, claim: { jobId: 'winner' } });
  });
});

describe('round 8 self-review: a leftover process group is the gate\'s, and no doubt reads as "gone" (PR 4764)', () => {
  const running = { status: 'running', sha: 'abc12345', startedAt: INPUT.requestStartedAt, suites: 'true' };
  const laneState = () => ({ marker: running, headSha: 'abc12345' });
  const noReattach = async () => ({ actions: [] });
  const soon = () => Date.parse(AT) + 60_000;
  const mk = (extra = {}) => createVerifyGateJobs({ store, reattach: noReattach, readHead: () => 'c0de', log: () => {},
    probe: () => 'dead', evict: () => {}, snapshot: {}, pidExists: () => false, groupExists: () => false, kill: vi.fn(), now: soon, ...extra });
  const finishedWith = (sidecar) => {
    const q = enqueueJob({ store, kindDef: VERIFY_GATE_JOB_KIND, input: INPUT, codeSha: 'c0de' });
    store.update(q.id, (r) => markFailed(r, { at: AT, reason: 'x' }));
    writeFileSync(gatePath(dir, q.id), JSON.stringify(sidecar));
    return q;
  };

  it('S1 — a finished job whose gate leader is proven gone while its group lives on: the group is killed each tick, the lane held until it is gone', async () => {
    const q = finishedWith({ pid: 990, handle: 'h:990:s', runId: 'run-1', dir: INPUT.dir });
    let group = true;
    const kill = vi.fn((pid, sig) => { if (sig === 'SIGKILL' && pid === -990) group = false; });
    const log = vi.fn();
    const jobs = mk({ kill, log, groupExists: () => group });
    const inFlight = new Map();
    await jobs.sync(inFlight);
    expect(kill).toHaveBeenCalledWith(-990, 'SIGKILL');
    expect(inFlight.get(INPUT.dir)).toMatchObject({ jobId: q.id, pid: null });
    expect(log.mock.calls.flat().join('\n')).toMatch(/leader pid 990 gone\) still has a live process group — lane held, killing it each tick/);
    await jobs.sync(inFlight);
    expect(inFlight.has(INPUT.dir)).toBe(false); // the group is gone now: proven, released
  });

  it('S1 — a pid that exists again (reused) is never killed as a leftover group, and a held-not-killed lane raises a HEALTH alert', async () => {
    finishedWith({ pid: 991, handle: 'h:991:s', runId: 'run-1', dir: INPUT.dir });
    const kill = vi.fn();
    const log = vi.fn();
    // probe dead + pid exists → the leader was reused: dead (as before). A pid-only record whose pid exists: unknown, held.
    const q2 = enqueueJob({ store, kindDef: VERIFY_GATE_JOB_KIND, input: { ...INPUT, dir: '/lanes/we/lane-4', runId: 'run-2' }, codeSha: 'c0de' });
    store.update(q2.id, (r) => markFailed(r, { at: AT, reason: 'x' }));
    writeFileSync(gatePath(dir, q2.id), JSON.stringify({ pid: 992, handle: null, runId: 'run-2' }));
    const inFlight = new Map();
    await mk({ kill, log, pidExists: () => true, groupExists: () => true }).sync(inFlight);
    expect(kill).not.toHaveBeenCalled();
    expect(inFlight.has(INPUT.dir)).toBe(false);
    expect(inFlight.get('/lanes/we/lane-4')).toMatchObject({ jobId: q2.id, pid: null });
    expect(log.mock.calls.flat().join('\n')).toMatch(/⚠ HEALTH gate job .* cannot be proven gone \(unknown\) — lane held, NOT killed.*release-lane --dir="\/lanes\/we\/lane-4"/);
  });

  it('S1 — a retry over a leftover group kills it and starts only once the group is proven gone; a group that survives refuses the run', async () => {
    writeFileSync(gatePath(dir, 'rt'), JSON.stringify({ pid: 993, handle: 'h:993:s', runId: 'run-1', dir: INPUT.dir }));
    let group = true;
    const kill = vi.fn((pid, sig) => { if (sig === 'SIGKILL' && pid === -993) group = false; });
    const runGate = vi.fn(async () => {});
    const out = await runGateStep({ jobId: 'rt', input: INPUT, jobsDir: dir, attempt: 2, runGate, log: () => {}, laneState, kill,
      probe: () => 'dead', pidExists: () => false, groupExists: () => group, scanLane: () => [], supervisorHandle: () => 'h:77:s', sleep: async () => {} });
    expect(kill).toHaveBeenCalledWith(-993, 'SIGKILL');
    expect(out.outcome).toBe('green');
    expect(runGate).toHaveBeenCalledTimes(1);

    writeFileSync(gatePath(dir, 'rs'), JSON.stringify({ pid: 994, handle: 'h:994:s', runId: 'run-1', dir: '/lanes/we/lane-9' }));
    const runGate2 = vi.fn(async () => {});
    const out2 = await runGateStep({ jobId: 'rs', input: { ...INPUT, dir: '/lanes/we/lane-9' }, jobsDir: dir, attempt: 2, runGate: runGate2, log: () => {},
      laneState, kill: vi.fn(), probe: () => 'dead', pidExists: () => false, groupExists: () => true, scanLane: () => [], supervisorHandle: () => 'h:77:s', sleep: async () => {} });
    expect(out2.outcome).toBe('failed');
    expect(runGate2).not.toHaveBeenCalled();
  });

  it('S1 — release-lane refuses while a recorded gate\'s leader exists nowhere but its group still has members', () => {
    const q = finishedWith({ pid: 995, handle: null, runId: 'run-1', dir: INPUT.dir });
    const refused = gateJob.releaseLaneByOperator({ jobsDir: dir, dir: INPUT.dir, deps: { probe: () => 'dead', pidExists: () => false, groupExists: () => true } });
    expect(refused.refused).toMatch(/process group of gate pid 995 still has members/);
    expect(JSON.parse(readFileSync(gatePath(dir, q.id), 'utf8'))).toMatchObject({ pid: 995 }); // untouched
    // A pid that exists with no start time is the doubt release-lane is for: released.
    expect(gateJob.releaseLaneByOperator({ jobsDir: dir, dir: INPUT.dir, deps: { probe: () => 'dead', pidExists: () => true, groupExists: () => true } }))
      .toMatchObject({ setAside: [q.id] });
  });

  it('S6 — markGone never overwrites a record a newer attempt wrote since the proof was read', () => {
    const old = { pid: 996, handle: 'h:996:s', runId: 'run-1', attempt: 1 };
    writeFileSync(gatePath(dir, 'mg'), JSON.stringify({ pid: null, handle: null, pending: true, runId: 'run-1', attempt: 2 }));
    gateJob.markGone(dir, 'mg', old);
    expect(JSON.parse(readFileSync(gatePath(dir, 'mg'), 'utf8'))).toMatchObject({ pending: true, attempt: 2 });
    writeFileSync(gatePath(dir, 'mg'), JSON.stringify(old));
    gateJob.markGone(dir, 'mg', old);
    expect(JSON.parse(readFileSync(gatePath(dir, 'mg'), 'utf8'))).toMatchObject({ pid: 996, gone: true });
  });

  it('S5 — a lane whose identity cannot be read (not "missing") is held, never keyed by another spelling', async () => {
    const loop = join(dir, 'loop');
    symlinkSync(loop, loop); // realpath: ELOOP
    expect(() => gateJob.laneRealDir(loop)).toThrow();
    expect(gateJob.laneRealDir(join(dir, 'gone', 'lane-1'))).toBe(join(dir, 'gone', 'lane-1')); // a missing lane: its resolved spelling
    expect(mk().laneHeld(loop)).toMatch(/cannot be listed/);
    const runGate = vi.fn(async () => {});
    const out = await runGateStep({ jobId: 'lp', input: { ...INPUT, dir: loop }, jobsDir: dir, runGate, log: () => {}, laneState,
      scanLane: () => [], supervisorHandle: () => 'h:77:s', probe: () => 'dead' });
    expect(out.outcome).toBe('failed');
    expect(runGate).not.toHaveBeenCalled();
  });
});

describe('findLaneGatePidsDefault (real processes)', () => {
  it('findLaneGatePidsDefault finds a real gate by its exact --repo token (with a --run-id), and nothing else', async () => {
    const lane = join(dir, 'lane 7'); // a space in the path must still match exactly
    // `--` ends node's own options: without it node rejects `--repo=` as a bad flag and exits at once.
    const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},30000)', '--', `--repo=${lane}`, '--json', '--run-id=r-x'], { stdio: 'ignore' });
    const decoy = spawn(process.execPath, ['-e', 'setTimeout(()=>{},30000)', '--', `--repo=${lane}`, 'request'], { stdio: 'ignore' });
    try {
      // Bounded by time, not by a poll count: under host load a `ps` alone can take seconds.
      for (const end = Date.now() + 20_000; Date.now() < end && !gateJob.findLaneGatePidsDefault(lane).includes(child.pid);) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(gateJob.findLaneGatePidsDefault(lane)).toEqual([child.pid]); // the decoy carries no --run-id: not a dispatched gate
      expect(gateJob.findLaneGatePidsDefault(`${lane}x`)).toEqual([]);
    } finally { child.kill('SIGKILL'); decoy.kill('SIGKILL'); }
  }, 60_000);
});
