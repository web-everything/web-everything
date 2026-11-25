/**
 * @file lane-lease-heartbeat.test.mjs — RS-7179-1: the lease renewal timer, with negative cases first
 *   (merge-path checklist 4 and 7): no lease, torn lease, foreign owner, reserved lease.
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, mkdirSync, rmdirSync, utimesSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { renewLaneLeaseOnce, startLaneLeaseHeartbeat } from '../lane-lease-heartbeat.mjs';
import { laneLeaseLockPath, withLaneLeaseMutation } from '../lane-lease-lock.mjs';
import { heartbeatMutationRace, judgeMutationRace, busyLeaseCommands, judgeBusyLeaseCommands } from '../../conveyor/soak/breaks/heartbeat-renewal-mutation-race.mjs';

const gitDir = () => mkdtempSync(join(tmpdir(), 'lease-hb-'));
const lease = { session: 'a', acquiredAt: '2026-11-25T00:00:00.000Z', ttlMinutes: 240 };
const put = (d, v) => writeFileSync(join(d, '.lane-lease'), typeof v === 'string' ? v : JSON.stringify(v));
const read = (d) => JSON.parse(readFileSync(join(d, '.lane-lease'), 'utf8'));
const at = new Date('2026-11-25T03:00:00.000Z');

describe('renewLaneLeaseOnce', () => {
  it('never creates a lease where none exists', () => {
    const d = gitDir();
    expect(renewLaneLeaseOnce({ cwd: 'x', leaseDirFn: () => d, now: () => at })).toBe(false);
    expect(existsSync(join(d, '.lane-lease'))).toBe(false);
  });
  it('writes nothing for a torn or non-object lease', () => {
    const d = gitDir();
    put(d, '{"session":');
    expect(renewLaneLeaseOnce({ cwd: 'x', leaseDirFn: () => d, now: () => at })).toBe(false);
    expect(readFileSync(join(d, '.lane-lease'), 'utf8')).toBe('{"session":');
    put(d, '[1]');
    expect(renewLaneLeaseOnce({ cwd: 'x', leaseDirFn: () => d, now: () => at })).toBe(false);
  });
  it('never extends a lease now held by another owner', () => {
    const d = gitDir();
    put(d, { ...lease, session: 'b' });
    expect(renewLaneLeaseOnce({ cwd: 'x', owner: 'a||2026-11-25T00:00:00.000Z', leaseDirFn: () => d, now: () => at })).toBe(false);
    expect(read(d).renewedAt).toBeUndefined();
  });
  it('leaves a reserved lease unchanged', () => {
    const d = gitDir();
    put(d, { ...lease, reserved: true });
    expect(renewLaneLeaseOnce({ cwd: 'x', leaseDirFn: () => d, now: () => at })).toBe(false);
  });
  it('refuses an identityless record, a changed holder and an expired lease', () => {
    const d = gitDir();
    put(d, { foo: 1 });
    expect(renewLaneLeaseOnce({ cwd: 'x', leaseDirFn: () => d, now: () => at })).toBe(false);
    put(d, { ...lease, holder: 'h2' });
    expect(renewLaneLeaseOnce({ cwd: 'x', owner: 'a|h1|2026-11-25T00:00:00.000Z', leaseDirFn: () => d, now: () => at })).toBe(false);
    put(d, { ...lease, ttlMinutes: 10 });
    expect(renewLaneLeaseOnce({ cwd: 'x', leaseDirFn: () => d, now: () => at })).toBe(false);
    expect(read(d).renewedAt).toBeUndefined();
  });
  it('does not overwrite a lease replaced during the write', () => {
    const d = gitDir();
    put(d, lease);
    const fs = {
      existsSync, readFileSync, rmSync: (p, o) => rmSync(p, o), renameSync: () => { throw new Error('must not rename'); },
      writeFileSync: (p, data, o) => { writeFileSync(p, data, o); put(d, { ...lease, session: 'other' }); },
    };
    expect(renewLaneLeaseOnce({ cwd: 'x', leaseDirFn: () => d, now: () => at, fs })).toBe(false);
    expect(read(d).session).toBe('other');
  });
  it('renews an owned lease atomically', () => {
    const d = gitDir();
    put(d, lease);
    expect(renewLaneLeaseOnce({ cwd: 'x', owner: 'a||2026-11-25T00:00:00.000Z', leaseDirFn: () => d, now: () => at })).toBe(true);
    expect(read(d).renewedAt).toBe(at.toISOString());
    expect(readdirSync(d)).toEqual(['.lane-lease']);
  });
  it.each(['release', 'acquire', 'adopt'])('coordinates with CLI %s immediately before rename', (action) => {
    expect(judgeMutationRace(heartbeatMutationRace(action))).toEqual([]);
  });
  it('contains publication errors and releases the mutation lock for retry', () => {
    const d = gitDir();
    put(d, lease);
    const fs = { existsSync, readFileSync, writeFileSync, rmSync,
      renameSync: () => { throw new Error('publication failed'); } };
    expect(renewLaneLeaseOnce({ cwd: 'x', leaseDirFn: () => d, now: () => at, fs })).toBe(false);
    expect(read(d)).toEqual(lease);
    expect(readdirSync(d)).toEqual(['.lane-lease']);
    expect(existsSync(laneLeaseLockPath(join(d, '.lane-lease')))).toBe(false);
    expect(renewLaneLeaseOnce({ cwd: 'x', leaseDirFn: () => d, now: () => at })).toBe(true);
  });
});

describe('lease mutation coordination', () => {
  it('skips a busy lane in auto-pick and cleanly refuses release while bulk release continues', () => {
    expect(judgeBusyLeaseCommands(busyLeaseCommands())).toEqual([]);
  });
  it('does not enumerate a held lock as a lane directory', () => {
    const pool = gitDir(), lane = join(pool, 'lane-1'), d = join(lane, '.git');
    mkdirSync(d, { recursive: true });
    withLaneLeaseMutation(join(d, '.lane-lease'), () => {
      expect(readdirSync(pool, { withFileTypes: true }).filter(e => e.isDirectory() && e.name.startsWith('lane-')).map(e => e.name)).toEqual(['lane-1']);
    });
  });
  it('never expires an abandoned lock; explicit recovery permits a later renewal', () => {
    const d = gitDir(), file = join(d, '.lane-lease');
    put(d, lease);
    // Resolve on disk: Vite rewrites relative new URL expressions into browser asset URLs.
    const helper = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '../lane-lease-lock.mjs')).href;
    const crashed = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import { withLaneLeaseMutation } from ${JSON.stringify(helper)}; withLaneLeaseMutation(process.argv[1], () => process.exit(0));`, file],
    { encoding: 'utf8', timeout: 5000, maxBuffer: 4096 });
    expect(crashed.status, crashed.stderr).toBe(0);
    const lock = laneLeaseLockPath(file);
    utimesSync(lock, new Date(0), new Date(0));
    expect(() => withLaneLeaseMutation(file, () => {})).toThrow(/confirm no writer remains/);
    expect(renewLaneLeaseOnce({ cwd: 'x', leaseDirFn: () => d, now: () => at })).toBe(false);
    expect(read(d)).toEqual(lease);
    // This fixture's writer is known to have exited; recovery is explicit.
    rmdirSync(lock);
    expect(renewLaneLeaseOnce({ cwd: 'x', leaseDirFn: () => d, now: () => at })).toBe(true);
  });
  it('uses the same mutex through symlink aliases and releases it on throw', () => {
    const d = gitDir(), alias = `${d}-alias`, file = join(d, '.lane-lease');
    symlinkSync(d, alias, 'dir');
    try {
      expect(() => withLaneLeaseMutation(file, () => {
        expect(() => withLaneLeaseMutation(join(alias, '.lane-lease'), () => {})).toThrow(/lease mutation busy/);
        throw new Error('injected failure');
      })).toThrow('injected failure');
      expect(existsSync(laneLeaseLockPath(file))).toBe(false);
      expect(withLaneLeaseMutation(file, () => 'recovered')).toBe('recovered');
    } finally { rmSync(alias); }
  });
  it('keeps the mutex outside an ordinary checkout during replacement', () => {
    const lane = gitDir(), d = join(lane, '.git');
    mkdirSync(d);
    const file = join(d, '.lane-lease');
    withLaneLeaseMutation(file, () => {
      rmSync(d, { recursive: true });
      mkdirSync(d);
      expect(() => withLaneLeaseMutation(file, () => {})).toThrow(/lease mutation busy/);
    });
    expect(withLaneLeaseMutation(file, () => true)).toBe(true);
  });
});

describe('startLaneLeaseHeartbeat', () => {
  it.each([
    { ownerSession: 'me' }, { workerSession: 'me', ownerSession: 'dispatcher' },
    { session: 'me' }, { holder: 'my-holder', ownerSession: 'dispatcher' },
  ])('renews a caller identity proven by %j', (identity) => {
    const d = gitDir();
    put(d, { ...lease, ...identity });
    const stop = startLaneLeaseHeartbeat({ cwds: ['lane'], callerSession: 'me', callerHolder: 'my-holder',
      leaseDirFn: () => d, now: () => at, setIntervalFn: () => ({}), clearIntervalFn: () => {} });
    stop();
    expect(read(d).renewedAt).toBe(at.toISOString());
  });
  it('does not claim ownership when the caller has no identity', () => {
    const d = gitDir();
    put(d, lease);
    startLaneLeaseHeartbeat({ cwds: ['lane'], callerSession: null, callerHolder: null, leaseDirFn: () => d, now: () => at });
    expect(read(d)).toEqual(lease);
  });
  it.each(['foreign session', 'same-session reacquire', 'new worker'])('preserves a %s lease between beats and reports loss through default stderr', (change) => {
    const d = gitDir();
    put(d, lease);
    let tick;
    const stop = startLaneLeaseHeartbeat({ cwds: ['lane'], callerSession: 'a',
      leaseDirFn: () => d, now: () => at, setIntervalFn: fn => { tick = fn; return {}; }, clearIntervalFn: () => {} });
    const replacement = change === 'new worker' ? { ...lease, workerSession: 'other' }
      : { ...lease, session: change === 'foreign session' ? 'other' : lease.session, holder: 'new-holder' };
    put(d, replacement);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      tick(); tick();
      expect(read(d)).toEqual(replacement);
      expect(stderr).toHaveBeenCalledTimes(1);
      expect(stderr.mock.calls[0][0]).toMatch(/lane-lease-heartbeat: could not renew.*lane.*run continues unprotected/);
    } finally { stop(); stderr.mockRestore(); }
  });
  it('does not capture or write a lease owned by another caller session', () => {
    const d = gitDir();
    put(d, { ...lease, ownerSession: 'someone-else', workerSession: 'someone-else' });
    const before = readFileSync(join(d, '.lane-lease'), 'utf8');
    let scheduled = false;
    const stop = startLaneLeaseHeartbeat({ cwds: ['lane'], callerSession: 'me',
      leaseDirFn: () => d, now: () => at,
      setIntervalFn: () => { scheduled = true; return {}; } });
    stop();
    expect(readFileSync(join(d, '.lane-lease'), 'utf8')).toBe(before);
    expect(scheduled).toBe(false);
  });
  it('uses the production session environment to refuse a foreign lease', () => {
    const d = gitDir();
    put(d, { ...lease, ownerSession: 'someone-else' });
    vi.stubEnv('CLAUDE_CODE_SESSION_ID', 'me');
    vi.stubEnv('LANE_SESSION', '');
    try {
      const stop = startLaneLeaseHeartbeat({ cwds: ['lane'], leaseDirFn: () => d, now: () => at });
      stop();
      expect(read(d)).toEqual({ ...lease, ownerSession: 'someone-else' });
    } finally { vi.unstubAllEnvs(); }
  });
  it('skips reserved caller leases without a false loss warning', () => {
    const d = gitDir();
    put(d, { ...lease, reserved: true });
    const warn = vi.fn(), setIntervalFn = vi.fn();
    startLaneLeaseHeartbeat({ cwds: ['lane'], callerSession: 'a', leaseDirFn: () => d, warn, setIntervalFn });
    expect(warn).not.toHaveBeenCalled();
    expect(setIntervalFn).not.toHaveBeenCalled();
    expect(read(d)).toEqual({ ...lease, reserved: true });
  });
  it('renews on start and on each tick until stopped; skips checkouts without a lease', () => {
    const d = gitDir();
    const none = gitDir();
    put(d, lease);
    let tick; let cleared = false; let n = 0;
    const stop = startLaneLeaseHeartbeat({
      cwds: ['lane', 'plain'], callerSession: 'a', leaseDirFn: (c) => (c === 'lane' ? d : none),
      now: () => new Date(at.getTime() + (n++) * 1000),
      setIntervalFn: (fn) => { tick = fn; return {}; }, clearIntervalFn: () => { cleared = true; },
    });
    const first = read(d).renewedAt;
    tick();
    expect(read(d).renewedAt).not.toBe(first);
    expect(existsSync(join(none, '.lane-lease'))).toBe(false);
    stop();
    expect(cleared).toBe(true);
  });
  it('beats at most every third of a short ttl and warns once when the lease is lost', () => {
    const d = gitDir();
    put(d, { ...lease, ttlMinutes: 3 });
    const warns = []; let period;
    startLaneLeaseHeartbeat({
      cwds: ['lane'], callerSession: 'a', leaseDirFn: () => d, now: () => new Date('2026-11-25T00:00:30.000Z'), warn: (l) => warns.push(l),
      setIntervalFn: (fn, ms) => { period = ms; rmSync(join(d, '.lane-lease')); fn(); fn(); return {}; }, clearIntervalFn: () => {},
    });
    expect(period).toBe(60_000);
    expect(warns).toHaveLength(1);
  });
  it('is a no-op stop when no checkout has a lease', () => {
    const stop = startLaneLeaseHeartbeat({ cwds: ['x'], leaseDirFn: () => gitDir() });
    expect(() => stop()).not.toThrow();
  });
});
