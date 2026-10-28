// @vitest-environment node
/**
 * #5755, round 1: executable contract for the timed-pass adapters, intentionally red.
 * runPassAsTimedJob({ passName, repo, entry }, ports) returns the original pass result
 * after completion (or { outcome: 'timeout' | 'quarantined' }). It schedules through
 * daemon-item-tasks, persists in ports.store, and uses the injected child/clock/stop.
 * runTimedPasses({ passes, runPass }) starts independent descriptors together and
 * collects their results in declaration order. makeCliMechanicalPasses uses that
 * wrapper and accepts runPass for the same injected timed-job boundary.
 * These are adapter APIs to implement, not a replacement task core in the fixture.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  runPassAsTimedJob, runPassDaemonLoop,
} from '../pass-daemon.mjs';
import {
  makeCliMechanicalPasses, MECHANICAL_PASS_NAMES, runTimedPasses,
} from '../runner.mjs';
import { createJobStore, stopHandle } from '../../../scripts/lib/daemon-jobs-runtime.mjs';
import { DEFAULT_TASK_TIMEOUT_MS } from '../../../scripts/lib/daemon-jobs.mjs';
import { taskIdentity } from '../../../scripts/lib/daemon-item-tasks.mjs';
import { validateTaskMetadata } from '../../../scripts/operations/job-record.mjs';

const REPO = 'web-everything/web-everything';
const descriptor = (passName, repo = REPO) => ({
  passName, repo, entry: { script: `scripts/conveyor/${passName}.mjs`, args: [] },
});
let dir;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-10T00:00:00Z'));
  if (!process.env.TMPDIR) throw new Error('this fixture requires the task TMPDIR');
  dir = mkdtempSync(join(process.env.TMPDIR, 'pass-timed-job-'));
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function fixture(policyOptions = {}) {
  const store = createJobStore(join(dir, 'jobs'));
  const children = [];
  const lines = [];
  const alerts = [];
  const signals = [];
  const spawnFn = vi.fn(() => {
    const child = new EventEmitter();
    child.pid = 7000 + children.length;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.unref = vi.fn();
    child.state = 'alive';
    child.finish = (code = 0, signal = null) => {
      child.state = 'dead';
      child.emit('exit', code, signal);
      child.emit('close', code, signal);
    };
    children.push(child);
    return child;
  });
  const probe = vi.fn(handle => {
    const pid = Number(handle.split(':')[1]);
    return children.find(child => child.pid === pid)?.state ?? 'unknown';
  });
  const kill = vi.fn((pid, signal) => {
    signals.push({ pid, signal });
    const child = children.find(c => c.pid === Math.abs(pid));
    if (signal === 'SIGKILL' && child?.state === 'alive') child.finish(null, signal);
  });
  // The real stopHandle is essential: resolving kill() is not proof of death.
  const stop = vi.fn((handle, options) => stopHandle(handle, {
    ...options, probe, kill, termGraceMs: 10, killGraceMs: 10, pollMs: 5,
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  }));
  const log = line => lines.push(String(line));
  const ports = {
    store, spawnFn, probe, stop,
    now: () => Date.now(),
    readStart: () => 'fixture-start', host: 'fixture-host',
    log, alert: detail => alerts.push(detail),
    // No host preferences, git snapshots, network, or real subprocesses.
    root: dir, codeSha: 'fixture-sha',
    snapshot: { materialize: vi.fn() },
    policyOptions: {
      platform: null, env: { WE_POLICY_CASCADE_LOG: '1' }, log,
      tool: { timeoutMs: 100 }, ...policyOptions,
    },
  };
  return { store, children, spawnFn, probe, stop, signals, lines, alerts, ports };
}

function timingLines(f) {
  return f.lines.filter(line => line.includes('task-timing')).map(line =>
    JSON.parse(line.slice(line.indexOf('{'))));
}

describe('#5755 independent timed pass jobs', () => {
  it.each([0, 7])('confirms the process group gone before completing child exit %s', async code => {
    const f = fixture();
    const reapGroup = vi.fn(() => true);
    const pending = runPassAsTimedJob(descriptor('branch-drift'), { ...f.ports, reapGroup });
    await vi.advanceTimersByTimeAsync(0);
    const [record] = f.store.list().records;
    f.children[0].finish(code);
    await expect(pending).resolves.toEqual({ code, signal: null });
    expect(reapGroup).toHaveBeenCalledWith(record.job.handle, Date.now(), { requireConfirmedDeath: true });
    expect(f.store.read(record.id).job.handle).toBeNull();
  });

  it.each(['pending', 'throws', 'unknown-owner'])('retains exclusion when child-exit cleanup is %s', async mode => {
    const f = fixture();
    const reapGroup = vi.fn(() => {
      if (mode === 'throws') throw new Error('group observation unavailable');
      return false;
    });
    const ports = { ...f.ports, reapGroup };
    const pass = descriptor('branch-drift');
    const pending = runPassAsTimedJob(pass, ports);
    await vi.advanceTimersByTimeAsync(0);
    const [record] = f.store.list().records;
    f.children[0].finish();
    if (mode === 'unknown-owner') f.probe.mockReturnValue('unknown');
    await expect(pending).resolves.toEqual({ outcome: 'quarantined' });
    expect(f.store.read(record.id).job).toMatchObject({
      status: 'running', handle: record.job.handle, passQuarantine: true,
    });
    expect(f.alerts).toHaveLength(1);
    await expect(runPassAsTimedJob(pass, { ...ports, store: createJobStore(f.store.dir) }))
      .resolves.toEqual({ outcome: 'quarantined' });
    expect(f.spawnFn).toHaveBeenCalledTimes(1);
  });

  it('runner completes other passes while one is slow, preserving result order', async () => {
    const f = fixture();
    const passes = ['branch-drift', 'lease-reaper', 'session-reaper'].map(name => descriptor(name));
    const completed = [];
    const runPass = pass => runPassAsTimedJob(pass, f.ports).then(result => {
      completed.push(pass.passName);
      return result;
    });
    let results;
    const pending = runTimedPasses({ passes, runPass }).then(value => { results = value; });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.spawnFn).toHaveBeenCalledTimes(3);
    f.children[2].finish(0);
    f.children[1].finish(7);
    await vi.advanceTimersByTimeAsync(0);
    expect(completed).toEqual(['session-reaper', 'lease-reaper']);
    expect(results).toBeUndefined();
    f.children[0].finish(0);
    await pending;
    expect(results).toEqual([
      { code: 0, signal: null }, { code: 7, signal: null }, { code: 0, signal: null },
    ]);
    expect(timingLines(f)).toHaveLength(3);
  });

  it('daemon keeps ticking during a hung pass without starting a second copy', async () => {
    const f = fixture();
    const sleep = vi.fn(ms => new Promise(resolve => setTimeout(resolve, ms)));
    const onRun = vi.fn();
    const pending = runPassDaemonLoop({
      runPass: () => runPassAsTimedJob(descriptor('branch-drift'), f.ports),
      sleep, intervalMs: 10, maxRuns: 4, tickWhileRunning: true, onRun,
    });
    await vi.advanceTimersByTimeAsync(35);
    expect(sleep.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(f.spawnFn).toHaveBeenCalledTimes(1);
    expect(f.children[0].state).toBe('alive');
    f.children[0].finish();
    await vi.advanceTimersByTimeAsync(0);
    await pending;
    expect(onRun.mock.calls.some(([result]) => result.code === 0)).toBe(true);
  });

  it('makeCliMechanicalPasses routes each enabled pass through the timed boundary', async () => {
    const slow = Promise.withResolvers();
    const completed = [];
    const runPass = vi.fn(async pass => {
      if (pass.passName === 'infra-blocked') await slow.promise;
      completed.push(pass.passName);
      return { code: 0, signal: null };
    });
    const exec = vi.fn(() => { throw new Error('inline execution bypassed timed jobs'); });
    const enabled = ['infra-blocked', 'lease-reaper', 'session-reaper'];
    const mechanical = makeCliMechanicalPasses({
      scriptsDir: 'scripts', repo: REPO, exec, runPass,
      skipPasses: new Set(MECHANICAL_PASS_NAMES.filter(name => !enabled.includes(name))),
    });
    const pending = mechanical({ out: {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(runPass.mock.calls.map(([pass]) => [pass.passName, pass.repo])).toEqual(
      enabled.map(name => [name, REPO]));
    expect(completed).toEqual(['lease-reaper', 'session-reaper']);
    expect(exec).not.toHaveBeenCalled();
    slow.resolve();
    // Today's mechanicalPasses effect returns undefined; keep that public result.
    await expect(pending).resolves.toBeUndefined();
  });

  it('kills at the cascade deadline, confirms death, and reports timeout exactly once', async () => {
    const f = fixture({
      platform: { timeoutMs: 400 }, tool: { timeoutMs: 200 }, envValues: { timeoutMs: 100 },
    });
    const pending = runPassAsTimedJob(descriptor('branch-drift'), f.ports);
    await vi.advanceTimersByTimeAsync(99);
    expect(f.stop).not.toHaveBeenCalled();
    expect(f.children[0].state).toBe('alive');
    const [record] = f.store.list().records;
    expect(validateTaskMetadata(record.job.task)).toEqual([]);
    expect(record.job.task).toMatchObject({ timeoutMs: 100, sources: { timeoutMs: 'env' } });
    expect(f.lines.join('\n')).toMatch(/timeoutMs[=:]100.*env/);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.stop).toHaveBeenCalledTimes(1);
    expect(f.stop).toHaveBeenCalledWith(record.job.handle, expect.objectContaining({ requireConfirmedDeath: true }));
    await vi.advanceTimersByTimeAsync(30);
    await expect(pending).resolves.toMatchObject({ outcome: 'timeout' });
    expect(f.signals).toContainEqual({ pid: -f.children[0].pid, signal: 'SIGTERM' });
    expect(f.signals).toContainEqual({ pid: -f.children[0].pid, signal: 'SIGKILL' });
    expect(f.probe(record.job.handle)).toBe('dead');
    expect(timingLines(f)).toEqual([expect.objectContaining({ outcome: 'timeout' })]);
    await vi.advanceTimersByTimeAsync(500);
    expect(timingLines(f)).toHaveLength(1);
  });

  it('uses the shared standard timeout when no layer overrides it, with provenance', async () => {
    const f = fixture({ tool: {} });
    const pending = runPassAsTimedJob(descriptor('lease-reaper'), f.ports);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.store.list().records[0].job.task).toMatchObject({
      timeoutMs: DEFAULT_TASK_TIMEOUT_MS, sources: { timeoutMs: 'standard' },
    });
    expect(f.lines.join('\n')).toContain(String(DEFAULT_TASK_TIMEOUT_MS));
    expect(f.lines.join('\n')).toContain('standard');
    f.children[0].finish();
    await expect(pending).resolves.toEqual({ code: 0, signal: null });
    expect(timingLines(f)).toHaveLength(1);
  });

  it('fails closed: an unconfirmable kill quarantines and alerts, retaining exclusion on restart', async () => {
    const f = fixture();
    const pass = descriptor('branch-drift');
    const pending = runPassAsTimedJob(pass, f.ports);
    await vi.advanceTimersByTimeAsync(99);
    const [before] = f.store.list().records;
    // Neither a lost process probe nor an acknowledged signal proves the owner gone.
    f.probe.mockImplementationOnce(() => 'alive');
    f.probe.mockImplementation(() => 'unknown');
    await vi.advanceTimersByTimeAsync(31);
    await expect(pending).resolves.toMatchObject({ outcome: 'quarantined' });
    expect(f.alerts).toHaveLength(1);
    expect(JSON.stringify(f.alerts)).toMatch(/inspect|manual|operator|recover/i);
    const retained = f.store.read(before.id);
    expect(retained.job.handle).toBe(before.job.handle);
    expect(['launching', 'running']).toContain(retained.job.status);
    // Recreate the store/adapter to rule out in-memory-only quarantine.
    const restarted = { ...f.ports, store: createJobStore(f.store.dir) };
    await expect(runPassAsTimedJob(pass, restarted)).resolves.toMatchObject({ outcome: 'quarantined' });
    expect(f.spawnFn).toHaveBeenCalledTimes(1);
    expect(timingLines(f)).toHaveLength(1);
  });

  it('reattaches the same (pass, repo) job but admits the same pass in another repo', async () => {
    const f = fixture();
    const first = runPassAsTimedJob(descriptor('branch-drift'), f.ports);
    await vi.advanceTimersByTimeAsync(0);
    const [record] = f.store.list().records;
    expect(taskIdentity(record.job.task)).toEqual(expect.objectContaining({ repo: REPO }));
    const restarted = { ...f.ports, store: createJobStore(f.store.dir) };
    const reattached = runPassAsTimedJob(descriptor('branch-drift'), restarted);
    const other = runPassAsTimedJob(descriptor('branch-drift', 'owner/other'), restarted);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.spawnFn).toHaveBeenCalledTimes(2);
    expect(f.store.list().records).toHaveLength(2);
    f.children.forEach(child => child.finish());
    await vi.advanceTimersByTimeAsync(0);
    await expect(Promise.all([first, reattached, other])).resolves.toEqual([
      { code: 0, signal: null }, { code: 0, signal: null }, { code: 0, signal: null },
    ]);
    expect(timingLines(f)).toHaveLength(2);
  });
});
