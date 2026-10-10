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
  gatePath, resultPath, VERIFY_GATE_JOB_KIND, gateState, findGatePidsDefault,
} from '../verify-gate-job.mjs';
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

    procs.clear(); // the orphan exits
    const again = await runGateStep({ jobId: 'w1', input: INPUT, jobsDir: dir, attempt: 3, log: () => {}, scan, laneState, runGate });
    expect(runGate).toHaveBeenCalledTimes(1);
    expect(again.outcome).toBe('green');
  });

  it('a finished job whose gate was never recorded holds its lane (no pid) while that gate runs, then releases it', async () => {
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
    expect(inFlight.has(INPUT.dir)).toBe(false);
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

  it('findGatePidsDefault finds a real process by its exact --run-id token, and not once it exits', async () => {
    const runId = `t-${process.pid}-${Date.now()}`;
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', '--', `--run-id=${runId}`], { stdio: 'ignore' });
    const exited = new Promise((r) => child.once('exit', r));
    try {
      await waitFor(() => findGatePidsDefault(runId).includes(child.pid));
      expect(findGatePidsDefault(`${runId}x`)).toEqual([]); // a token match, not a prefix match
      expect(findGatePidsDefault(runId.slice(0, -1))).toEqual([]);
    } finally { child.kill('SIGKILL'); }
    await exited;
    expect(findGatePidsDefault(runId)).toEqual([]);
  }, 20_000);
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
