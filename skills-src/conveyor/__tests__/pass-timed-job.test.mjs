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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  runPassAsTimedJob, runPassDaemonLoop,
} from '../pass-daemon.mjs';
import {
  makeCliMechanicalPasses, MECHANICAL_PASS_NAMES, runTimedPasses,
} from '../runner.mjs';
import { createJobStore, localHostAliases, probeHandle, reapDeadGroup, stopHandle } from '../../../scripts/lib/daemon-jobs-runtime.mjs';
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
    reapGroup: vi.fn(handle => probe(handle) === 'dead'),
    env: {}, eventsPath: join(dir, 'daemon-events.jsonl'),
    now: () => Date.now(),
    readStart: () => new Date(Date.now()).toISOString(), host: 'fixture-host',
    aliases: new Set(['fixture-host', 'fixture-host.local']),
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

function quarantineEvents(f, path = f.ports.eventsPath) {
  return readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line));
}

// Persist the historical shape: a non-terminal job with a retained handle and
// passResult, but no quarantine timestamp or notification timestamp.
async function quarantinedFixture() {
  const f = fixture();
  const pass = descriptor('branch-drift');
  f.ports.reapGroup.mockReturnValue(false);
  const pending = runPassAsTimedJob(pass, f.ports);
  await vi.advanceTimersByTimeAsync(0);
  const [record] = f.store.list().records;
  f.children[0].finish();
  await expect(pending).resolves.toEqual({ outcome: 'quarantined' });
  // Historical quarantines predate unreapable state/alerts. Recovery must create
  // both afresh, rather than accidentally satisfying assertions from this launch.
  f.store.update(record.id, r => { delete r.job.passUnreapable; return r; });
  f.alerts.length = 0;
  return { ...f, pass, record };
}

describe('timed pass quarantine recovery and reporting', () => {
  it('retains quarantine when an injected probe reports dead without an independent reapGroup', async () => {
    const f = await quarantinedFixture();
    f.probe.mockReturnValue('dead');
    const { reapGroup, ...ports } = f.ports;
    const pending = runPassAsTimedJob(f.pass, ports);
    expect(f.store.read(f.record.id).job).toMatchObject({
      passQuarantine: true, handle: f.record.job.handle,
    });
    await expect(pending).resolves.toEqual({ outcome: 'quarantined' });
    expect(f.spawnFn).toHaveBeenCalledTimes(1);
    expect(quarantineEvents(f)).toEqual([expect.objectContaining({
      kind: 'pass-quarantined', detail: expect.objectContaining({
        ownerLiveness: 'dead', groupGone: false,
        reason: expect.stringContaining('operator must inspect owner/process group'),
      }),
    })]);
  });

  it.each(['alive', 'unknown'])(
    'retains quarantine for an %s owner without invoking a group reaper that would confirm gone', async ownerLiveness => {
      const f = await quarantinedFixture();
      const retained = f.store.read(f.record.id).job;
      f.probe.mockReset().mockReturnValue(ownerLiveness);
      f.ports.reapGroup.mockReset().mockReturnValue(true);

      await expect(runPassAsTimedJob(f.pass, {
        ...f.ports, store: createJobStore(f.store.dir),
      })).resolves.toEqual({ outcome: 'quarantined' });

      expect(f.probe).toHaveBeenCalledWith(retained.handle);
      expect(f.ports.reapGroup).not.toHaveBeenCalled();
      expect(f.store.read(f.record.id).job).toMatchObject({
        status: retained.status, handle: retained.handle, passQuarantine: true,
      });
      expect(f.store.list().records.map(r => r.id)).toEqual([f.record.id]);
      expect(f.spawnFn).toHaveBeenCalledTimes(1);
      expect(quarantineEvents(f)[0]).toMatchObject({
        kind: 'pass-quarantined', detail: { ownerLiveness, groupGone: false },
      });
    },
  );

  it.each(['quarantine', 'reattachment', 'expired deadline'].flatMap(mode =>
    ['server', 'server.local', 'Old-Computer'].map(recordedHost => [mode, recordedHost])))(
    'recovers %s for a dead owner recorded under local alias %s', async (mode, recordedHost) => {
      const f = await quarantinedFixture();
      f.store.update(f.record.id, r => {
        r.job.host = recordedHost;
        r.job.handle = `${recordedHost}:${r.job.pid}:${r.job.procStart}`;
        if (mode !== 'quarantine') {
          delete r.job.passQuarantine;
          delete r.job.passResult;
        }
        return r;
      });
      if (mode === 'expired deadline') vi.setSystemTime(Date.now() + 200);
      const handle = f.store.read(f.record.id).job.handle;
      const host = 'server.example';
      const aliases = localHostAliases({ host, platform: 'linux' });
      aliases.add('Old-Computer'); // e.g. a trusted macOS ComputerName alias
      const probe = vi.fn(h => h === handle
        ? probeHandle(h, { host, aliases, readStart: () => null }) : f.probe(h));
      const reapGroup = vi.fn((h, notAfterMs, options) => reapDeadGroup(h, {
        ...options, notAfterMs, host, aliases,
        kill: () => { throw Object.assign(new Error('no group'), { code: 'ESRCH' }); },
      }));

      const pending = runPassAsTimedJob(f.pass, { ...f.ports, host, aliases, probe, reapGroup });
      if (mode === 'quarantine') {
        await vi.waitFor(() => expect(f.children).toHaveLength(2));
        f.children[1].finish();
        await expect(pending).resolves.toEqual({ code: 0, signal: null });
        expect(quarantineEvents(f)[0].kind).toBe('pass-quarantine-cleared');
      } else {
        await expect(pending).resolves.toMatchObject(mode === 'expired deadline'
          ? { outcome: 'timeout' } : { spawnError: 'pass owner exited without a recorded result' });
        expect(f.spawnFn).toHaveBeenCalledTimes(1);
      }

      expect(f.store.read(f.record.id).job).toMatchObject({ status: 'failed', handle: null });
      expect(f.store.read(f.record.id).job.passQuarantine).toBeUndefined();
      expect(reapGroup).toHaveBeenCalledWith(handle, expect.any(Number), { requireConfirmedDeath: true });
    },
  );

  it.each(['orphaned descendants', 'live reused leader'])(
    'never SIGKILLs unrelated PID/PGID 7000 reused while the daemon was down (%s)', async mode => {
      const f = await quarantinedFixture();
      const ownerStart = Date.now();
      f.store.update(f.record.id, r => {
        r.job.procStart = new Date(ownerStart).toISOString();
        r.job.handle = `fixture-host:7000:${r.job.procStart}`;
        return r;
      });
      vi.setSystemTime(ownerStart + 2 * 60 * 60 * 1000);
      const kill = vi.fn(); // the unrelated group still exists
      const reapGroup = (handle, notAfterMs, options) => reapDeadGroup(handle, {
        ...options, notAfterMs, host: 'fixture-host', kill, bootTime: () => 0,
        readStart: () => mode === 'live reused leader' ? new Date(ownerStart + 60_000).toISOString() : null,
        groupStarts: () => [ownerStart + 60_000],
      });

      await expect(runPassAsTimedJob(f.pass, { ...f.ports, reapGroup }))
        .resolves.toEqual({ outcome: 'quarantined' });

      expect(kill).not.toHaveBeenCalledWith(-7000, 'SIGKILL');
      expect(f.store.read(f.record.id).job).toMatchObject({ passQuarantine: true, passUnreapable: true });
      expect(f.alerts).toContainEqual(expect.objectContaining({ kind: 'needs-you', id: f.record.id }));
      expect(f.spawnFn).toHaveBeenCalledTimes(1);
    },
  );

  it('still reaps a genuine orphaned group of the same recorded owner after daemon downtime', async () => {
    const f = await quarantinedFixture();
    const ownerStart = Date.now();
    f.store.update(f.record.id, r => {
      r.job.procStart = new Date(ownerStart).toISOString();
      r.job.handle = `fixture-host:7000:${r.job.procStart}`;
      return r;
    });
    vi.setSystemTime(ownerStart + 2 * 60 * 60 * 1000);
    let groupAlive = true;
    const kill = vi.fn((pid, signal) => {
      if (pid !== -7000 || !groupAlive) throw Object.assign(new Error('no group'), { code: 'ESRCH' });
      if (signal === 'SIGKILL') groupAlive = false;
    });
    const reapGroup = vi.fn((handle, notAfterMs, options) => reapDeadGroup(handle, {
      ...options, notAfterMs, host: 'fixture-host', kill,
      readStart: () => null, bootTime: () => 0, groupStarts: () => [ownerStart + 500],
    }));

    const pending = runPassAsTimedJob(f.pass, { ...f.ports, reapGroup });
    await vi.waitFor(() => expect(f.children).toHaveLength(2));
    f.children[1].finish();
    await expect(pending).resolves.toEqual({ code: 0, signal: null });

    expect(kill).toHaveBeenCalledWith(-7000, 'SIGKILL');
    expect(reapGroup).toHaveBeenCalledWith(`fixture-host:7000:${new Date(ownerStart).toISOString()}`,
      ownerStart + 1000, { requireConfirmedDeath: true });
    expect(f.store.read(f.record.id).job.passQuarantine).toBeUndefined();
    expect(f.store.read(f.record.id).job.passUnreapable).toBeUndefined();
  });

  it.each(['invalid owner start', 'missing last-alive time', 'member past owner tolerance', 'host rebooted', 'unreadable leader'])(
    'does not signal an unprovable group: %s', async mode => {
      const f = await quarantinedFixture();
      const ownerStart = Date.now();
      f.store.update(f.record.id, r => {
        if (mode === 'invalid owner start') {
          r.job.procStart = 'unparseable-start';
          r.job.handle = `fixture-host:7000:${r.job.procStart}`;
        }
        if (mode === 'missing last-alive time') {
          r.job.heartbeatAt = null;
          r.job.startedAt = null;
        }
        // A late heartbeat must never widen the owner-start bound.
        if (mode === 'member past owner tolerance') r.job.heartbeatAt = new Date(ownerStart + 60_000).toISOString();
        return r;
      });
      vi.setSystemTime(ownerStart + 2 * 60 * 60 * 1000);
      const kill = vi.fn();
      const reapGroup = (handle, notAfterMs, options) => reapDeadGroup(handle, {
        ...options, notAfterMs, host: 'fixture-host', kill,
        readStart: () => {
          if (mode === 'unreadable leader') throw new Error('ps unavailable');
          return null;
        },
        bootTime: () => mode === 'host rebooted' ? ownerStart + 60_000 : 0,
        groupStarts: () => [ownerStart + (mode === 'member past owner tolerance' ? 1001 : 500)],
      });

      await expect(runPassAsTimedJob(f.pass, { ...f.ports, reapGroup }))
        .resolves.toEqual({ outcome: 'quarantined' });

      expect(kill).not.toHaveBeenCalledWith(-7000, 'SIGKILL');
      expect(f.store.read(f.record.id).job).toMatchObject({ passQuarantine: true, passUnreapable: true });
      expect(f.alerts).toContainEqual(expect.objectContaining({ kind: 'needs-you' }));
    },
  );

  it.each(['reattachment', 'expired deadline'])(
    'does not SIGKILL a reused orphan group during %s before quarantine was recorded', async mode => {
      const f = await quarantinedFixture();
      const ownerStart = Date.now();
      f.store.update(f.record.id, r => {
        delete r.job.passQuarantine;
        delete r.job.passResult;
        if (mode === 'reattachment') {
          r.job.task.timeoutMs = 3 * 60 * 60 * 1000;
          r.job.task.policy.timeoutMs = r.job.task.timeoutMs;
        }
        return r;
      });
      vi.setSystemTime(ownerStart + 2 * 60 * 60 * 1000);
      const kill = vi.fn();
      const reapGroup = (handle, notAfterMs, options) => reapDeadGroup(handle, {
        ...options, notAfterMs, host: 'fixture-host', kill, bootTime: () => 0,
        readStart: () => null, groupStarts: () => [ownerStart + 60_000],
      });

      await expect(runPassAsTimedJob(f.pass, { ...f.ports, reapGroup }))
        .resolves.toEqual({ outcome: 'quarantined' });

      expect(kill).not.toHaveBeenCalledWith(-7000, 'SIGKILL');
      expect(f.store.read(f.record.id).job).toMatchObject({ passQuarantine: true, passUnreapable: true });
      expect(f.alerts).toContainEqual(expect.objectContaining({ kind: 'needs-you' }));
    },
  );

  it('clears a dead owner with a confirmed empty pgid and runs a fresh job in the same call', async () => {
    const f = await quarantinedFixture();
    const ageMs = 2 * 60 * 60 * 1000;
    vi.setSystemTime(Date.now() + ageMs);
    const reaper = vi.fn((handle, notAfterMs, options) => reapDeadGroup(handle, {
      ...options, notAfterMs, host: 'fixture-host',
      kill: () => { throw Object.assign(new Error('no group'), { code: 'ESRCH' }); },
    }));
    const pending = runPassAsTimedJob(f.pass, { ...f.ports, reapGroup: reaper });
    await vi.waitFor(() => expect(f.children).toHaveLength(2));
    f.children[1].finish();
    await expect(pending).resolves.toEqual({ code: 0, signal: null });
    const old = f.store.read(f.record.id).job;
    expect(old.passQuarantine).toBeUndefined();
    expect(old).toMatchObject({ status: 'failed', handle: null, error: expect.stringMatching(/quarantine.*cleared/i) });
    const fresh = f.store.list().records.find(r => r.id !== f.record.id);
    expect(fresh.job).toMatchObject({ status: 'succeeded', task: { seq: f.record.job.task.seq + 1 } });
    expect(reaper).toHaveBeenCalledWith(f.record.job.handle, expect.any(Number), { requireConfirmedDeath: true });
    expect(quarantineEvents(f)).toEqual([expect.objectContaining({
      kind: 'pass-quarantine-cleared', detail: expect.objectContaining({
        ts: expect.any(String), passName: f.pass.passName, jobId: f.record.id,
        pid: f.children[0].pid, pgid: f.children[0].pid, ageMs,
      }),
    })]);
    expect(f.lines.some(line => line.includes('pass-quarantine-cleared') && line.includes(f.record.id))).toBe(true);
  });

  it('retains quarantine for a dead owner with a LIVE pgid even after an acknowledged reap', async () => {
    const f = await quarantinedFixture();
    const kill = vi.fn(); // signal 0 succeeds; SIGKILL is acknowledged but the group survives
    const reaper = vi.fn((handle, notAfterMs, options) => reapDeadGroup(handle, {
      ...options, notAfterMs, host: 'fixture-host', readStart: () => null,
      bootTime: () => 0, groupStarts: () => [Date.now()], kill,
    }));
    // A real start time lets the shared reaper attempt SIGKILL and check again.
    f.store.update(f.record.id, r => {
      r.job.procStart = new Date(Date.now()).toISOString();
      r.job.handle = `fixture-host:${f.children[0].pid}:${r.job.procStart}`;
      return r;
    });
    await expect(runPassAsTimedJob(f.pass, { ...f.ports, reapGroup: reaper }))
      .resolves.toEqual({ outcome: 'quarantined' });
    expect(kill).toHaveBeenCalledWith(-f.children[0].pid, 'SIGKILL');
    expect(f.store.read(f.record.id).job.passQuarantine).toBe(true);
    expect(f.spawnFn).toHaveBeenCalledTimes(1);
    expect(quarantineEvents(f)[0]).toMatchObject({ kind: 'pass-quarantined', detail: { groupGone: false } });
  });

  it('reports a live owner once per hour across restarts, including its id, pid and age', async () => {
    const f = await quarantinedFixture();
    f.children[0].state = 'alive';
    const ports = { ...f.ports, store: createJobStore(f.store.dir) };
    const run = () => runPassAsTimedJob(f.pass, ports);
    await expect(run()).resolves.toEqual({ outcome: 'quarantined' });
    const emittedAt = f.store.read(f.record.id).job.passQuarantineEventAt;
    expect(emittedAt).toBeDefined();
    vi.setSystemTime(Date.now() + 60 * 60 * 1000 - 1);
    await expect(run()).resolves.toEqual({ outcome: 'quarantined' });
    expect(quarantineEvents(f)).toHaveLength(1);
    vi.setSystemTime(Date.now() + 1);
    await expect(run()).resolves.toEqual({ outcome: 'quarantined' });
    const events = quarantineEvents(f);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ kind: 'pass-quarantined', detail: {
      jobId: f.record.id, pid: f.children[0].pid, ageMs: 3600000,
      age: expect.any(String), ownerLiveness: 'alive', livenessUnknown: false,
    } });
    expect(f.store.read(f.record.id).job.passQuarantineEventAt).not.toEqual(emittedAt);
    expect(f.lines.filter(line => line.includes('pass-quarantined'))).toHaveLength(2);
    expect(f.spawnFn).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['1ms in the future', 1],
    ['2h in the future', 2 * 60 * 60 * 1000],
    ['unparsable', null],
  ])('emits immediately for a persisted %s timestamp and restores hourly throttling', async (_name, offsetMs) => {
    const f = await quarantinedFixture();
    const emittedAt = new Date(Date.now()).toISOString();
    f.store.update(f.record.id, r => {
      r.job.passQuarantineEventAt = offsetMs === null ? 'not-a-timestamp' : new Date(Date.now() + offsetMs).toISOString();
      return r;
    });
    const run = () => runPassAsTimedJob(f.pass, { ...f.ports, store: createJobStore(f.store.dir) });

    await expect(run()).resolves.toEqual({ outcome: 'quarantined' });
    expect(quarantineEvents(f)).toEqual([expect.objectContaining({
      kind: 'pass-quarantined', detail: expect.objectContaining({ ts: emittedAt }),
    })]);
    expect(f.store.read(f.record.id).job.passQuarantineEventAt).toBe(emittedAt);

    await expect(run()).resolves.toEqual({ outcome: 'quarantined' });
    expect(quarantineEvents(f)).toHaveLength(1);
    vi.setSystemTime(Date.now() + 60 * 60 * 1000);
    await expect(run()).resolves.toEqual({ outcome: 'quarantined' });
    expect(quarantineEvents(f)).toHaveLength(2);
    expect(f.spawnFn).toHaveBeenCalledTimes(1);
  });

  it.each(['unknown', 'throws', 'unreadable-handle', 'group-throws', 'group-unknown'])(
    'fails closed and reports unknown liveness when evidence is %s', async mode => {
      const f = await quarantinedFixture();
      if (mode === 'unknown') f.probe.mockReturnValue('unknown');
      if (mode === 'throws') f.probe.mockImplementation(() => { throw new Error('probe unavailable'); });
      if (mode === 'unreadable-handle') {
        f.store.update(f.record.id, r => { r.job.status = 'launching'; r.job.handle = null; return r; });
        f.probe.mockReturnValue('dead'); // probeHandle treats a missing handle as dead
        f.ports.reapGroup.mockReturnValue(true);
      }
      if (mode === 'group-throws') f.ports.reapGroup.mockImplementation(() => { throw new Error('ps unavailable'); });
      if (mode === 'group-unknown') f.ports.reapGroup.mockReturnValue('unknown');
      await expect(runPassAsTimedJob(f.pass, f.ports)).resolves.toEqual({ outcome: 'quarantined' });
      expect(f.store.read(f.record.id).job.passQuarantine).toBe(true);
      expect(f.spawnFn).toHaveBeenCalledTimes(1);
      expect(quarantineEvents(f)[0]).toMatchObject({ kind: 'pass-quarantined', detail: { livenessUnknown: true } });
      expect(f.lines.some(line => line.includes('pass-quarantined') && line.includes('unknown'))).toBe(true);
    },
  );

  it.each([
    ['record host mismatch', { host: 'other-host' }],
    ['record and handle use different local aliases', { host: 'fixture-host.local' }],
    ['record host missing', { host: undefined }],
    ['record host null', { host: null }],
    ['record pid mismatch', { pid: 8000 }],
    ['record pid missing', { pid: undefined }],
    ['record pid null', { pid: null }],
    ['record start mismatch', { procStart: 'different-start' }],
    ['record start missing', { procStart: undefined }],
    ['record start null', { procStart: null }],
    ['record start empty', { procStart: '' }],
    ['handle host mismatch', { handle: 'other-host:7000:2026-10-10T00:00:00.000Z' }],
    ['consistent foreign host', { host: 'other-host', handle: 'other-host:7000:2026-10-10T00:00:00.000Z' }],
    ['unrecognized FQDN with local short name', { host: 'fixture-host.foreign', handle: 'fixture-host.foreign:7000:2026-10-10T00:00:00.000Z' }],
    ['handle pid mismatch', { handle: 'fixture-host:8000:2026-10-10T00:00:00.000Z' }],
    ['handle start mismatch', { handle: 'fixture-host:7000:different-start' }],
    ['group identity mismatch', { pgid: 8000 }],
  ])('fails closed and reports unknown liveness for %s despite dead/gone probes', async (_name, patch) => {
    const f = await quarantinedFixture();
    f.store.update(f.record.id, r => { Object.assign(r.job, patch); return r; });
    const retained = f.store.read(f.record.id).job;
    f.probe.mockReset().mockReturnValue('dead');
    f.ports.reapGroup.mockReset().mockReturnValue(true);
    f.spawnFn.mockImplementation(() => { throw new Error('unexpected replacement launch'); });

    await expect(runPassAsTimedJob(f.pass, f.ports)).resolves.toEqual({ outcome: 'quarantined' });

    expect(f.store.read(f.record.id).job).toMatchObject({
      ...retained, passQuarantine: true,
    });
    expect(f.probe).not.toHaveBeenCalled();
    expect(f.ports.reapGroup).not.toHaveBeenCalled();
    expect(f.spawnFn).toHaveBeenCalledTimes(1);
    expect(quarantineEvents(f)[0]).toMatchObject({ kind: 'pass-quarantined', detail: {
      ownerLiveness: 'unknown', livenessUnknown: true, groupGone: false,
      reason: expect.stringContaining('operator must inspect'),
    } });
  });

  it.each([false, true])('retries a failed append immediately without advancing the throttle (previous event=%s)', async previous => {
    const f = await quarantinedFixture();
    const previousAt = previous ? new Date(Date.now() - 3600000).toISOString() : undefined;
    if (previous) f.store.update(f.record.id, r => { r.job.passQuarantineEventAt = previousAt; return r; });
    writeFileSync(f.ports.eventsPath, 'parent is a file');
    const ports = { ...f.ports, eventsPath: join(f.ports.eventsPath, 'unwritable.jsonl') };

    await expect(runPassAsTimedJob(f.pass, ports)).resolves.toEqual({ outcome: 'quarantined' });
    expect(f.store.read(f.record.id).job.passQuarantineEventAt).toBe(previousAt);
    expect(f.lines.some(line => line.includes('pass-quarantined') && line.includes('failed to append'))).toBe(true);

    // Restart with repaired event storage at the same clock time: no hour-long silence.
    await expect(runPassAsTimedJob(f.pass, {
      ...f.ports, store: createJobStore(f.store.dir), eventsPath: join(dir, 'repaired-events.jsonl'),
    })).resolves.toEqual({ outcome: 'quarantined' });
    expect(quarantineEvents(f, join(dir, 'repaired-events.jsonl'))).toHaveLength(1);
    expect(f.store.read(f.record.id).job.passQuarantineEventAt).toBe(new Date(Date.now()).toISOString());
    expect(f.spawnFn).toHaveBeenCalledTimes(1);
  });

  it.each(['persist', 'clear'])('event-write failure cannot change the quarantine %s outcome', async mode => {
    const f = await quarantinedFixture();
    writeFileSync(f.ports.eventsPath, 'parent is a file');
    const ports = { ...f.ports, eventsPath: join(f.ports.eventsPath, 'unwritable.jsonl') };
    if (mode === 'persist') {
      await expect(runPassAsTimedJob(f.pass, ports)).resolves.toEqual({ outcome: 'quarantined' });
    } else {
      ports.reapGroup = () => true;
      const pending = runPassAsTimedJob(f.pass, ports);
      await vi.waitFor(() => expect(f.children).toHaveLength(2));
      f.children[1].finish();
      await expect(pending).resolves.toEqual({ code: 0, signal: null });
    }
    expect(f.lines.some(line => line.includes(mode === 'persist' ? 'pass-quarantined' : 'pass-quarantine-cleared'))).toBe(true);
    expect(f.lines.some(line => line.includes(mode === 'persist' ? 'pass-quarantined' : 'pass-quarantine-cleared')
      && line.includes('failed to append'))).toBe(true);
    expect(f.store.read(f.record.id).job.passQuarantine).toBe(mode === 'persist' ? true : undefined);
  });

  it.each(['WE_DAEMON_EVENTS', 'WE_DAEMON_EVENTS_PATH'])('honours the %s event-path override', async variable => {
    const f = await quarantinedFixture();
    const eventsPath = join(dir, 'env-events.jsonl');
    await expect(runPassAsTimedJob(f.pass, {
      ...f.ports, eventsPath: undefined, env: { [variable]: eventsPath },
    })).resolves.toEqual({ outcome: 'quarantined' });
    expect(quarantineEvents(f, eventsPath)[0].kind).toBe('pass-quarantined');
  });
});

describe('#5755 independent timed pass jobs', () => {
  it.each([false, true])('keeps deadline ownership across reattachment before claim (expired=%s)', async expired => {
    const f = fixture();
    const pass = descriptor('launch-race');
    let reattached;
    let duringLaunch;
    const pending = runPassAsTimedJob(pass, {
      ...f.ports,
      readStart: () => {
        if (expired) vi.setSystemTime(Date.now() + 101);
        // The launch has spawned but has not published its handle. Re-enter before
        // activePasses is populated, as an independent adapter process would.
        reattached = runPassAsTimedJob(pass, { ...f.ports, store: createJobStore(f.store.dir) });
        duringLaunch = f.store.list().records[0].job;
        return new Date(Date.now()).toISOString();
      },
    });
    expect(duringLaunch).toMatchObject({ status: 'launching', handle: null });
    expect(duringLaunch.passResult).toBeUndefined();
    expect(duringLaunch.passQuarantine).toBeUndefined();
    expect(f.alerts).toHaveLength(expired ? 1 : 0);
    await vi.advanceTimersByTimeAsync(150);
    await expect(pending).resolves.toEqual({ outcome: 'timeout' });
    expect(f.children[0].state).toBe('dead');
    expect(f.signals).toContainEqual({ pid: -f.children[0].pid, signal: 'SIGKILL' });
    expect(f.spawnFn).toHaveBeenCalledTimes(1);
    await expect(reattached).resolves.toMatchObject({ outcome: expired ? 'quarantined' : 'timeout' });
    expect(f.store.list().records[0].job).toMatchObject({ passResult: { outcome: 'timeout' }, handle: null });
    expect(timingLines(f)).toEqual([expect.objectContaining({ outcome: 'timeout' })]);
  });

  it.each([0, 7])('confirms the process group gone before completing child exit %s', async code => {
    const f = fixture();
    const reapGroup = vi.fn(() => true);
    const pending = runPassAsTimedJob(descriptor('branch-drift'), { ...f.ports, reapGroup });
    await vi.advanceTimersByTimeAsync(0);
    const [record] = f.store.list().records;
    f.children[0].finish(code);
    await expect(pending).resolves.toEqual({ code, signal: null });
    expect(reapGroup).toHaveBeenCalledWith(record.job.handle, Date.now(),
      { requireConfirmedDeath: true });
    expect(f.store.read(record.id).job.handle).toBeNull();
  });

  it.each([
    { code: 0, expired: false }, { code: 7, expired: false }, { code: 0, expired: true },
  ])('reaps a late-spawned straggler after locally observed child exit $code (expired=$expired)', async ({ code, expired }) => {
    const f = fixture({ tool: { timeoutMs: 60_000 } });
    const ownerStart = Date.now();
    let groupAlive = true;
    const kill = vi.fn((pid, signal) => {
      if (pid !== -7000 || !groupAlive) throw Object.assign(new Error('no group'), { code: 'ESRCH' });
      if (signal === 'SIGKILL') groupAlive = false;
    });
    const reapGroup = vi.fn((handle, notAfterMs, options) => reapDeadGroup(handle, {
      ...options, notAfterMs, host: 'fixture-host', kill,
      readStart: () => null, bootTime: () => 0, groupStarts: () => [ownerStart + 5000],
    }));
    const pending = runPassAsTimedJob(descriptor('branch-drift'), { ...f.ports, reapGroup });
    await vi.advanceTimersByTimeAsync(10_000);
    const [record] = f.store.list().records;
    // The local exit can arrive at the deadline before the polling timer fires.
    if (expired) vi.setSystemTime(ownerStart + 60_000);
    f.children[0].finish(code);

    await expect(pending).resolves.toEqual(expired ? { outcome: 'timeout' } : { code, signal: null });
    expect(kill).toHaveBeenCalledWith(-7000, 'SIGKILL');
    expect(groupAlive).toBe(false);
    expect(reapGroup).toHaveBeenCalledWith(record.job.handle, ownerStart + (expired ? 60_000 : 10_000),
      { requireConfirmedDeath: true });
    expect(f.store.read(record.id).job).toMatchObject({ status: code === 0 && !expired ? 'succeeded' : 'failed', handle: null });
    expect(f.store.read(record.id).job.passQuarantine).toBeUndefined();
    expect(f.alerts).toHaveLength(0);
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
