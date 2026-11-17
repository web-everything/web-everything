import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { once } from 'node:events';
import { fork } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyRunningMarker, verifyGateDecision, verifyStartBody, verifyFinishBody,
  waitForVerifySettle, verifyPidAlive } from '../lane-verify.mjs';
import { markerLock, startVerifyLifecycle, updateOwnedMarker } from '../lane-verify-lifecycle.mjs';

const nowMs = Date.parse('2026-11-17T12:00:00Z');
const iso = ago => new Date(nowMs - ago).toISOString();
const start = verifyStartBody({ sha: 'abc', suites: 'gate', startedAt: iso(60 * 60_000),
  runId: 'one', pid: 123, heartbeatAt: iso(0) });
const classify = (record, pidAlive = null, extra = {}) => classifyRunningMarker({ record, nowMs, pidAlive, staleMs: 180_000, ...extra });
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const root = () => { const dir = mkdtempSync(join(tmpdir(), 'verify-lifecycle-')); roots.push(dir); return dir; };

describe('running marker liveness', () => {
  it('dead PID is orphaned even with a fresh heartbeat', () => {
    expect(classify(start, false)).toEqual({ state: 'orphaned', reason: 'dead-pid' });
  });
  it('stale heartbeat with an unknown PID is orphaned', () => {
    expect(classify({ ...start, heartbeatAt: iso(180_001) })).toEqual({ state: 'orphaned', reason: 'stale-heartbeat' });
  });
  it('a live run is never orphaned, and a fresh heartbeat with unknown PID stays alive', () => {
    expect(classify({ ...start, heartbeatAt: iso(999_999) }, true).state).toBe('alive');
    expect(classify(start).state).toBe('alive');
    expect(verifyGateDecision({ record: { ...start, heartbeatAt: iso(999_999) }, headSha: 'abc',
      nowMs, pidAlive: true, requireVerified: false })).toMatchObject({ ok: false, status: 'running' });
  });
  it('a queued request gets a generous window and requires proof of no dispatcher entry', () => {
    const request = { ...start, pid: undefined, requestedAt: iso(0), heartbeatAt: iso(180_001) };
    expect(classify(request, null, { dispatcherRun: false }).state).toBe('requested');
    const stale = { ...request, heartbeatAt: iso(31 * 60_000) };
    expect(classify(stale, null, { dispatcherRun: false })).toEqual({ state: 'orphaned', reason: 'stale-heartbeat' });
    for (const dispatcherRun of [true, null, undefined]) expect(classify(stale, null, { dispatcherRun }).state).toBe('requested');
  });
  it('old markers without PID/heartbeat retain both mandatory refusal and advisory TTL behavior', () => {
    const record = verifyStartBody({ sha: 'abc', startedAt: iso(31 * 60_000) });
    expect(verifyGateDecision({ record, headSha: 'abc', nowMs })).toMatchObject({ ok: false, status: 'running' });
    expect(verifyGateDecision({ record, headSha: 'abc', nowMs, requireVerified: false })).toMatchObject({ ok: true, status: 'untracked' });
  });
  it('without relevant-change carry-forward input, green requires a completed exact-SHA run', () => {
    // This invariant covers exact-SHA verification only: no laneRelevantChangeSince input.
    // The existing carried-forward-green policy is tested separately and remains unchanged.
    for (const record of [start, { ...start, heartbeatAt: iso(999_999) }]) {
      for (const requireVerified of [true, false]) expect(verifyGateDecision({ record, headSha: 'abc', nowMs, pidAlive: false, requireVerified }))
        .toMatchObject({ ok: false, status: 'orphaned', reason: 'dead-pid' });
    }
    const finished = verifyFinishBody(start, { sha: 'abc', finishedAt: iso(0), exitCode: 0 });
    expect(verifyGateDecision({ record: finished, headSha: 'abc' })).toMatchObject({ ok: true, status: 'green' });
    expect(verifyGateDecision({ record: finished, headSha: 'other' })).toMatchObject({ ok: false, status: 'absent' });
  });
  it('wait stops immediately on an orphan without sleeping or polling to timeout', async () => {
    const sleep = vi.fn();
    expect(await waitForVerifySettle({ readRecord: () => start, readHead: () => 'abc', headSha: 'abc',
      now: () => nowMs, pidAlive: () => false, sleep, ceilingMs: 100_000 })).toMatchObject({
      ok: false, status: 'orphaned', reason: 'dead-pid', settled: false, waited: { ms: 0, polls: 1 },
    });
    expect(sleep).not.toHaveBeenCalled();
  });
  it('signal handlers retain their precise terminal cause and the existing public signal verdict', () => {
    const record = verifyFinishBody(start, { sha: 'abc', finishedAt: iso(0), exitCode: 143,
      infrastructure: { reason: 'killed-SIGTERM', detail: 'killed-SIGTERM' } });
    expect(record.infrastructure.reason).toBe('killed-SIGTERM');
    expect(verifyGateDecision({ record, headSha: 'abc' })).toMatchObject({ ok: false, status: 'infrastructure-failure', reason: 'verify-signal' });
  });
  it('PID probing requires ESRCH for death and keeps existing processes with unknown identity alive', () => {
    const gone = () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); };
    expect(verifyPidAlive(123, { kill: gone })).toBe(false);
    expect(verifyPidAlive(123, { kill: () => { throw new Error('denied'); } })).toBe(null);
    expect(verifyPidAlive(123, { kill: () => {}, exec: () => 'S node scripts/verify-lane.mjs' })).toBe(true);
    expect(verifyPidAlive(123, { kill: () => {}, exec: () => 'Z node scripts/verify-lane.mjs' })).toBe(true);
    expect(verifyPidAlive(123, { kill: () => {}, exec: () => 'S unrelated' })).toBe(true);
    expect(verifyPidAlive(123, { kill: () => {}, exec: () => { throw new Error('unavailable'); } })).toBe(true);
  });
  it.each(['--run-id=one-new', '--run-id one-new'])('an explicit different %s immediately disproves ownership despite an earlier start', flag => {
    const exec = vi.fn((_cmd, args) => args.includes('lstart=')
      ? new Date(nowMs - 2 * 60 * 60_000).toString() : `S node scripts/verify-lane.mjs ${flag}`);
    const probe = (pid, { record }) => verifyPidAlive(pid, { record, kill: () => {}, exec });
    expect(probe(123, { record: start })).toBe(false);
    expect(exec).toHaveBeenCalledOnce();
    expect(exec).toHaveBeenCalledWith('ps', ['-ww', '-o', 'stat=,command=', '-p', '123'], expect.objectContaining({ timeout: 1000 }));
    expect(verifyGateDecision({ record: start, headSha: 'abc', nowMs, pidAlive: probe }))
      .toMatchObject({ ok: false, status: 'orphaned', reason: 'dead-pid' });
  });
  it('exact run-id argv or a matching PID started before its marker proves the same live run', () => {
    const probe = (argv, started, record = start) => verifyPidAlive(123, { record, kill: () => {},
      exec: (_cmd, args) => args.includes('lstart=') ? started : `S node scripts/verify-lane.mjs ${argv}` });
    expect(probe('--run-id=one', 'unreadable')).toBe(true);
    expect(probe('', new Date(nowMs - 2 * 60 * 60_000).toString())).toBe(true);
    expect(probe('', new Date(nowMs).toString(), { ...start, pid: 456 })).toBe(false);
    expect(verifyGateDecision({ record: { ...start, heartbeatAt: iso(999_999) }, headSha: 'abc', nowMs,
      pidAlive: (pid, { record }) => probe('--run-id=one', 'unreadable', record) }))
      .toMatchObject({ ok: false, status: 'running' });
  });
  it.each(['unreadable', '', null])('a live run is never orphaned with unavailable process start evidence: %s', started => {
    const probe = (pid, { record }) => verifyPidAlive(pid, { record, kill: () => {}, exec: (_cmd, args) => {
      if (!args.includes('lstart=')) return 'S node scripts/verify-lane.mjs';
      if (started === null) throw new Error('ps unavailable');
      return started;
    } });
    expect(probe(123, { record: start })).toBe(true);
    expect(verifyGateDecision({ record: { ...start, heartbeatAt: iso(999_999) }, headSha: 'abc', nowMs,
      pidAlive: probe })).toMatchObject({ ok: false, status: 'running' });
  });
  it.each(['', null])('a successful PID probe stays alive when ps argv is unavailable: %s', argv => {
    const probe = (pid, { record }) => verifyPidAlive(pid, { record, kill: () => {}, exec: () => {
      if (argv === null) throw new Error('unavailable');
      return argv;
    } });
    expect(probe(123, { record: start })).toBe(true);
    expect(verifyGateDecision({ record: { ...start, heartbeatAt: iso(999_999) }, headSha: 'abc', nowMs,
      pidAlive: probe })).toMatchObject({ ok: false, status: 'running' });
  });
  it.each([0, 999])('same-second process start is indeterminate and stays alive (marker offset %ims)', offset => {
    const record = { ...start, startedAt: new Date(nowMs + offset).toISOString(), heartbeatAt: iso(999_999) };
    const probe = (pid, { record }) => verifyPidAlive(pid, { record, kill: () => {},
      exec: (_cmd, args) => args.includes('lstart=') ? new Date(nowMs).toUTCString() : 'S node scripts/verify-lane.mjs' });
    expect(probe(123, { record })).toBe(true);
    expect(verifyGateDecision({ record, headSha: 'abc', nowMs, pidAlive: probe })).toMatchObject({ ok: false, status: 'running' });
  });
  it('a process start proven after the marker second disproves ownership without an argv run-id', () => {
    expect(verifyPidAlive(123, { record: { ...start, startedAt: new Date(nowMs - 1).toISOString() },
      kill: () => {}, exec: (_cmd, args) => args.includes('lstart=') ? new Date(nowMs).toUTCString() : 'S node scripts/verify-lane.mjs' })).toBe(false);
  });
  it('an unreadable marker start time cannot disprove ownership of a live PID', () => {
    expect(verifyPidAlive(123, { record: { ...start, startedAt: 'unreadable' }, kill: () => {},
      exec: (_cmd, args) => args.includes('lstart=') ? new Date(nowMs).toUTCString() : 'S node scripts/verify-lane.mjs' })).toBe(true);
  });
});

describe('marker ownership and exit paths', () => {
  it.each(['verify-lane.mjs', 'verify-dispatch.mjs'])('default lock identity recognizes %s with readable process evidence', script => {
    const dir = root();
    const pidProbe = (pid, options) => verifyPidAlive(pid, { ...options, kill: () => {}, exec: () => `S node scripts/${script}` });
    const release = markerLock(dir, { pid: 123, pidProbe });
    try { expect(markerLock(dir, { pidProbe })).toBe(null); }
    finally { release(); }
  });
  it('a live verify-dispatch lock holder cannot have its lock stolen', async () => {
    const dir = root();
    const script = join(dir, 'verify-dispatch.mjs');
    writeFileSync(script, "process.on('message', () => {}); process.send('ready');");
    const child = fork(script, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    let release;
    try {
      await once(child, 'message');
      release = markerLock(dir, { pid: child.pid });
      expect(release).toBeTypeOf('function');
      expect(markerLock(dir)).toBe(null);
    } finally {
      release?.();
      const closed = once(child, 'close');
      child.kill('SIGKILL');
      await closed;
    }
  });
  it('concurrent takeover has exactly one winner and recovers a dead lock without evicting a live owner', async () => {
    const dir = root();
    const options = { pid: 123, pidAlive: () => true, now: () => nowMs };
    const contenders = await Promise.all([Promise.resolve().then(() => markerLock(dir, options)),
      Promise.resolve().then(() => markerLock(dir, options))]);
    expect(contenders.filter(Boolean)).toHaveLength(1);
    expect(markerLock(dir, { ...options, now: () => nowMs + 99_999_999 })).toBe(null);
    const recovered = markerLock(dir, { ...options, pid: 456, pidAlive: () => false });
    expect(recovered).toBeTypeOf('function');
    contenders.find(Boolean)(); // stale release must not remove the replacement.
    expect(markerLock(dir, options)).toBe(null);
    recovered();
  });
  it('heartbeat and terminal CAS never overwrite another SHA or same-SHA runId', () => {
    const dir = root();
    const path = join(dir, '.lane-verify');
    const writeMarker = record => writeFileSync(path, JSON.stringify(record));
    const readMarker = () => JSON.parse(readFileSync(path, 'utf8'));
    for (const record of [{ ...start, sha: 'other' }, { ...start, runId: 'two' }]) {
      writeMarker(record);
      expect(updateOwnedMarker({ gitDir: dir, expected: start, readMarker, writeMarker, update: () => ({ ...start, status: 'green' }) })).toBe(false);
      expect(readMarker()).toEqual(record);
    }
    writeMarker(start);
    expect(updateOwnedMarker({ gitDir: dir, expected: start, readMarker, writeMarker, update: current => ({ ...current, heartbeatAt: iso(-30_000) }) })).toBe(true);
    expect(readMarker().heartbeatAt).toBe(iso(-30_000));
  });
  it('terminal writes retry transient lock contention and acquire the lock before writing', () => {
    let clock = 0;
    let record = start;
    const release = vi.fn();
    const lock = vi.fn(() => clock < 100 ? null : release);
    const writeMarker = vi.fn(next => { record = next; });
    expect(updateOwnedMarker({ gitDir: root(), expected: start, readMarker: () => record, writeMarker,
      update: current => ({ ...current, status: 'infrastructure-failure' }), lock, retryMs: 2000,
      now: () => clock, wait: ms => { clock += ms; } })).toBe(true);
    expect(clock).toBe(100);
    expect(lock).toHaveBeenCalledTimes(3);
    expect(writeMarker).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });
  it('heartbeat holds the lock across read, ownership CAS and write, and skips a busy lock', () => {
    let record = start;
    let held = false;
    let busy = false;
    let beat;
    const readMarker = vi.fn(() => { expect(held).toBe(true); return record; });
    const writeMarker = vi.fn(next => { expect(held).toBe(true); record = next; });
    const release = vi.fn(() => { held = false; });
    const lock = () => { if (busy) return null; held = true; return release; };
    const life = startVerifyLifecycle({ expected: start, events: new EventEmitter(), now: () => nowMs + 30_000,
      update: (update, options) => updateOwnedMarker({ gitDir: root(), expected: start, readMarker, writeMarker,
        update, lock, ...options }), setIntervalFn: fn => { beat = fn; return {}; }, clearIntervalFn: vi.fn() });
    beat();
    expect(record.heartbeatAt).toBe(new Date(nowMs + 30_000).toISOString());
    expect(held).toBe(false);
    expect(release).toHaveBeenCalledOnce();
    busy = true;
    beat();
    expect(readMarker).toHaveBeenCalledOnce();
    expect(writeMarker).toHaveBeenCalledOnce();
    busy = false;
    record = { ...start, runId: 'replacement' };
    beat();
    expect(record).toEqual({ ...start, runId: 'replacement' });
    expect(readMarker).toHaveBeenCalledTimes(2);
    expect(writeMarker).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledTimes(2);
    life.stop();
  });
  it.each(['busy', 'unreadable'])('terminal persistence bounds %s lock retries to 2s and exits without writing, leaving an orphan', failure => {
    let clock = 0;
    let record = start;
    const events = new EventEmitter();
    const log = vi.fn();
    const readMarker = vi.fn(() => record);
    const writeMarker = vi.fn(next => { record = next; });
    const exit = vi.fn(code => {
      expect(code).toBe(3);
      expect(record).toEqual(start);
      expect(classify(record, false)).toEqual({ state: 'orphaned', reason: 'dead-pid' });
    });
    const lock = vi.fn(() => { if (failure === 'unreadable') throw new Error('lock unreadable'); return null; });
    const life = startVerifyLifecycle({ expected: start, events, exit, log, now: () => nowMs,
      update: (update, options) => updateOwnedMarker({ gitDir: root(), expected: start,
        readMarker, writeMarker, update, lock, ...options,
        now: () => clock, wait: ms => { clock += ms; } }),
      setIntervalFn: () => ({}), clearIntervalFn: vi.fn() });
    events.emit('SIGTERM');
    expect(clock).toBe(2000);
    expect(lock).toHaveBeenCalledTimes(41);
    expect(readMarker).not.toHaveBeenCalled();
    expect(writeMarker).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/terminal marker write.*(lock unavailable|lock unreadable).*leaving marker for orphan detection.*rerun/));
    expect(exit).toHaveBeenCalledOnce();
    life.stop();
  });
  it.each([{ ...start, runId: 'replacement' }, { ...start, sha: 'other' }, { ...start, status: 'green' }])(
    'terminal retry preserves a marker replaced while waiting: %j', replacement => {
      let record = start;
      let clock = 0;
      const writeMarker = vi.fn();
      expect(updateOwnedMarker({ gitDir: root(), expected: start, readMarker: () => record, writeMarker,
        update: current => ({ ...current, status: 'infrastructure-failure' }), lock: () => clock < 100 ? null : vi.fn(),
        retryMs: 2000, now: () => clock,
        wait: ms => { clock += ms; record = replacement; } })).toBe(false);
      expect(writeMarker).not.toHaveBeenCalled();
      expect(record).toEqual(replacement);
    });
  it('an unwritable terminal marker emits an operator fallback and still exits with infra code', () => {
    const events = new EventEmitter();
    const log = vi.fn();
    const exit = vi.fn();
    const life = startVerifyLifecycle({ expected: start, events, exit, log,
      update: () => { throw new Error('disk denied'); }, setIntervalFn: () => ({}), clearIntervalFn: vi.fn() });
    events.emit('SIGTERM');
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/terminal marker write failed.*disk denied.*inspect.*rerun/));
    expect(exit).toHaveBeenCalledWith(3);
    life.stop();
  });
  it.each(['SIGTERM', 'SIGINT', 'SIGHUP'])('%s terminates the active gate before writing and exiting', signal => {
    const calls = [];
    const events = new EventEmitter();
    const life = startVerifyLifecycle({ expected: start, events, terminateGate: () => calls.push('kill'),
      update: () => calls.push('write'), exit: code => calls.push(code),
      setIntervalFn: () => ({}), clearIntervalFn: vi.fn() });
    events.emit(signal);
    expect(calls).toEqual(['kill', 'write', 3]);
    life.stop();
  });
  it.each(['SIGTERM', 'SIGINT', 'SIGHUP', 'uncaughtException', 'unhandledRejection', 'exit', 'admission-timeout'])(
    '%s writes an infrastructure terminal record before exiting', event => {
      const events = new EventEmitter();
      let record = start;
      let beat;
      const unref = vi.fn();
      const exit = vi.fn(() => expect(record.status).toBe('infrastructure-failure'));
      const life = startVerifyLifecycle({ expected: start, events, now: () => nowMs,
        update: fn => { if (record.status === 'running') record = fn(record); }, exit,
        setIntervalFn: (fn, ms) => { beat = fn; expect(ms).toBe(30_000); return { unref }; }, clearIntervalFn: vi.fn() });
      beat();
      expect(unref).toHaveBeenCalledOnce();
      if (event === 'admission-timeout') life.stopWith(event, 3); else events.emit(event, new Error('fixture'));
      expect(record).toMatchObject({ sha: 'abc', runId: 'one', status: 'infrastructure-failure', finishedAt: iso(0),
        infrastructure: { reason: event.startsWith('SIG') ? `killed-${event}` : event === 'admission-timeout' ? event : 'crashed' } });
      life.stop();
      expect(events.eventNames()).toHaveLength(0);
    });
});
