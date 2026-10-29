import { describe, it, expect, vi, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import fs, { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readIdentity, sameIdentity, liveness, currentBootId, listGroup, boundedReadFile, boundedReaddir } from '../proc-identity.mjs';

const PID = 12345;
const UID = 501;
const BOOT = '8b61301a-27f4-4828-9ce1-9fc23bf14377';
const OTHER_BOOT = '7b61301a-27f4-4828-9ce1-9fc23bf14377';
const START = 'Tue Oct 28 13:30:00 2026';
const HEADER = ' RUID   PID  PPID  PGID STAT                  STARTED\n';
const enoent = () => Object.assign(new Error('missing process'), { code: 'ENOENT' });

function stat({ pid = PID, pgid = PID, startTime = '987654', state = 'S' } = {}) {
  // Fields 3–22: state, ppid, pgrp, fields 6–21, starttime. The final ')' ends comm.
  return `${pid} (worker ) with spaces (nested)) ${[state, 1, pgid, ...Array(16).fill(0), startTime].join(' ')}\n`;
}

function psRow({ pid = PID, pgid = PID, uid = UID, state = 'Ss', startTime = START } = {}) {
  return `  ${uid} ${pid} 1 ${pgid} ${state}   ${startTime}\n`;
}

function linuxDeps({ processes = [{ pid: PID }], bootId = BOOT } = {}) {
  const files = new Map([['/proc/sys/kernel/random/boot_id', ` ${bootId}\n`]]);
  processes.forEach((entry) => {
    files.set(`/proc/${entry.pid}/stat`, stat(entry));
    files.set(`/proc/${entry.pid}/status`, `Name:\tworker\nUid:\t${entry.uid ?? UID}\t902\t903\t904\n`);
  });
  return {
    platform: 'linux',
    kill: vi.fn(() => { throw Object.assign(new Error('no such process'), { code: 'ESRCH' }); }),
    uid: 9999, // Must never stand in for another process's real uid.
    readFile: vi.fn((path) => {
      if (!files.has(path)) throw enoent();
      return files.get(path);
    }),
    readdir: vi.fn((path) => {
      expect(path).toBe('/proc');
      return ['self', 'sys', ...processes.map(({ pid }) => String(pid))];
    }),
    exec: vi.fn(() => { throw new Error('Linux probes must read procfs'); }),
  };
}

function darwinDeps({ output = HEADER + psRow(), bootId = BOOT } = {}) {
  return {
    platform: 'darwin',
    uid: 9999,
    readFile: vi.fn(() => { throw new Error('Darwin probes must use exec'); }),
    exec: vi.fn((file, args) => {
      if (file === '/usr/sbin/sysctl' && JSON.stringify(args) === JSON.stringify(['-n', 'kern.bootsessionuuid'])) {
        return ` ${bootId}\n`;
      }
      if (file === '/bin/ps') return output;
      throw new Error(`Unexpected executable: ${file}`);
    }),
  };
}

const linuxIdentity = { pid: PID, startTime: '987654', bootId: BOOT, uid: UID, state: 'S' };
const darwinIdentity = { ...linuxIdentity, startTime: START };

describe('readIdentity parsers', () => {
  it.each(['Sgarbled', 'R?', 'S\u0000'])('macOS malformed state %s stays unknown throughout', (state) => {
    const deps = darwinDeps({ output: HEADER + psRow({ state }) });
    expect(readIdentity(PID, deps).status).toBe('unknown');
    expect(liveness(darwinIdentity, deps)).toBe('unknown');
    const groupDeps = darwinDeps({ output: HEADER + psRow() + psRow({ pid: PID + 1, state }) });
    expect(listGroup(PID, groupDeps)).toEqual({ status: 'unknown', reason: expect.any(String) });
  });

  it.each(['+', '<', '>', 'A', 'E', 'L', 'N', 'S', 's', 'V', 'W', 'X'])('macOS accepts documented state modifier %s', (modifier) => {
    const deps = darwinDeps({ output: HEADER + psRow({ state: `S${modifier}` }) });
    expect(readIdentity(PID, deps)).toEqual({ status: 'ok', identity: darwinIdentity });
    expect(liveness(darwinIdentity, deps)).toBe('alive');
    expect(listGroup(PID, deps)).toEqual({ status: 'ok', identities: [darwinIdentity] });
  });

  it('macOS reads the real uid, not a differing effective uid', () => {
    const deps = darwinDeps();
    const exec = deps.exec;
    deps.exec = vi.fn((file, args, options) => {
      if (file === '/bin/ps') {
        const uid = args.includes('ruid,pid,ppid,pgid,stat,lstart') ? UID : UID + 1;
        return HEADER + psRow({ uid });
      }
      return exec(file, args, options);
    });
    expect(readIdentity(PID, deps)).toEqual({ status: 'ok', identity: darwinIdentity });
    expect(liveness({ ...darwinIdentity, uid: UID + 1 }, deps)).toBe('dead');
    expect(listGroup(PID, deps)).toEqual({ status: 'ok', identities: [darwinIdentity] });
  });

  it.each(['linux', 'darwin'])('%s unrecognised process state stays unknown throughout', (platform) => {
    const deps = platform === 'linux'
      ? linuxDeps({ processes: [{ pid: PID, state: 'Q' }] })
      : darwinDeps({ output: HEADER + psRow({ state: 'Q' }) });
    expect(readIdentity(PID, deps).status).toBe('unknown');
    expect(liveness(platform === 'linux' ? linuxIdentity : darwinIdentity, deps)).toBe('unknown');
    expect(listGroup(PID, deps).status).toBe('unknown');
  });

  it('a non-decimal Linux process group is malformed evidence', () => {
    const deps = linuxDeps({ processes: [{ pid: PID, pgid: '1e4' }] });
    expect(readIdentity(PID, deps).status).toBe('unknown');
    expect(liveness(linuxIdentity, deps)).toBe('unknown');
    expect(listGroup(PID, deps).status).toBe('unknown');
  });

  it('an impossible ps start timestamp is unknown, even when recorded identically', () => {
    const startTime = 'Bad Foo 99 99:99:99 2026';
    const deps = darwinDeps({ output: HEADER + psRow({ startTime }) });
    expect(readIdentity(PID, deps).status).toBe('unknown');
    expect(liveness({ ...darwinIdentity, startTime }, deps)).toBe('unknown');
    expect(listGroup(PID, deps).status).toBe('unknown');
  });

  it('Linux parses field 22 after the last comm parenthesis and reads the first status Uid', () => {
    expect(readIdentity(PID, linuxDeps())).toEqual({ status: 'ok', identity: linuxIdentity });
  });

  it('macOS skips the header, normalises lstart whitespace, and uses the first stat character', () => {
    const deps = darwinDeps({ output: HEADER + psRow({ startTime: 'Tue  Oct   28 13:30:00   2026' }) });
    expect(readIdentity(PID, deps)).toEqual({ status: 'ok', identity: darwinIdentity });
  });

  it('Linux ENOENT is gone and liveness is dead', () => {
    const deps = linuxDeps({ processes: [] });
    expect(readIdentity(PID, deps)).toEqual({ status: 'gone' });
    expect(liveness(linuxIdentity, deps)).toBe('dead');
  });

  it('empty macOS ps output is gone and liveness is dead', () => {
    const deps = darwinDeps({ output: '' });
    expect(readIdentity(PID, deps)).toEqual({ status: 'gone' });
    expect(liveness(darwinIdentity, deps)).toBe('dead');
  });

  it.each(['', HEADER, Buffer.from(HEADER)])('macOS ps no-match exit returns gone and dead (%j)', (stdout) => {
    const deps = darwinDeps();
    const exec = deps.exec;
    deps.exec = vi.fn((file, ...args) => {
      if (file === '/bin/ps') throw Object.assign(new Error('ps exited 1'), { status: 1, stdout, stderr: '', signal: null });
      return exec(file, ...args);
    });
    expect(readIdentity(PID, deps)).toEqual({ status: 'gone' });
    expect(liveness(darwinIdentity, deps)).toBe('dead');
    expect(listGroup(PID, deps).status).toBe('unknown');
    expect(deps.exec).toHaveBeenCalledWith('/bin/ps', ['-A', '-o', 'ruid,pid,ppid,pgid,stat,lstart'], expect.any(Object));
  });

  it.each([
    { status: 2, stdout: HEADER }, { status: 1 },
    { status: 1, stdout: HEADER + psRow() }, { status: 1, stdout: 'garbled' },
    { status: 1, stdout: ' '.repeat(1024 * 1024 + 1) },
    { status: 1, stdout: HEADER, code: 'ETIMEDOUT' },
    { status: 1, stdout: HEADER, signal: 'SIGKILL' },
    { status: 1, stdout: HEADER, stderr: 'ps: denied' },
  ])('macOS execution failure remains unknown: %j', (details) => {
    const deps = darwinDeps();
    deps.exec = vi.fn(() => { throw Object.assign(new Error('ps failure'), details); });
    expect(readIdentity(PID, deps).status).toBe('unknown');
    expect(liveness(darwinIdentity, deps)).toBe('unknown');
  });

  it.each(['ENOENT', 'ESRCH'])('Linux %s plus unreadable boot id stays unknown', (code) => {
    const deps = linuxDeps({ processes: [] });
    deps.readFile = () => { throw Object.assign(new Error('unreadable'), { code }); };
    expect(readIdentity(PID, deps).status).toBe('unknown');
    expect(liveness(linuxIdentity, deps)).toBe('unknown');
  });

  it.each(['live', 'EPERM', 'EACCES'])('Linux hidden stat with %s existence probe stays unknown', (result) => {
    const deps = linuxDeps({ processes: [] });
    deps.kill = vi.fn(() => {
      if (result !== 'live') throw Object.assign(new Error('denied'), { code: result });
      return true;
    });
    expect(readIdentity(PID, deps).status).toBe('unknown');
    expect(liveness(linuxIdentity, deps)).toBe('unknown');
    expect(deps.kill).toHaveBeenCalledWith(PID, 0);
  });

  it('unreadable Linux evidence fails closed as unknown, with a reason', () => {
    const deps = linuxDeps();
    deps.readFile = vi.fn(() => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); });
    expect(readIdentity(PID, deps)).toEqual({ status: 'unknown', reason: expect.any(String) });
    expect(liveness(linuxIdentity, deps)).toBe('unknown');
  });

  it('missing Linux Uid evidence is unknown rather than using deps.uid', () => {
    const deps = linuxDeps();
    const readFile = deps.readFile;
    deps.readFile = (path) => path.endsWith('/status') ? 'Name:\tworker\n' : readFile(path);
    expect(readIdentity(PID, deps)).toEqual({ status: 'unknown', reason: expect.any(String) });
    expect(liveness(linuxIdentity, deps)).toBe('unknown');
  });

  it('Linux PID reuse between stat and status invalidates identity, liveness and the whole group', () => {
    const probe = (check) => {
      const deps = linuxDeps();
      const readFile = deps.readFile;
      let replaced = false;
      deps.readFile = (path) => {
        if (path.endsWith('/status')) replaced = true;
        if (path.endsWith('/stat') && replaced) return stat({ startTime: '987655' });
        return readFile(path);
      };
      return check(deps);
    };
    expect(probe((deps) => readIdentity(PID, deps)).status).toBe('unknown');
    expect(probe((deps) => liveness(linuxIdentity, deps))).toBe('unknown');
    expect(probe((deps) => listGroup(PID, deps))).toEqual({ status: 'unknown', reason: expect.any(String) });
  });

  it.each(['Z', 'X', 'x'])('Linux transition to %s during the UID read never reports alive', (state) => {
    const probe = (check) => {
      const deps = linuxDeps();
      const readFile = deps.readFile;
      let exited = false;
      deps.readFile = (path) => {
        if (path.endsWith('/status')) exited = true;
        if (path.endsWith('/stat') && exited) return stat({ state });
        return readFile(path);
      };
      return check(deps);
    };
    expect(probe((deps) => readIdentity(PID, deps))).toEqual({ status: 'ok', identity: { ...linuxIdentity, state } });
    expect(probe((deps) => liveness(linuxIdentity, deps))).toBe('dead');
    expect(probe((deps) => listGroup(PID, deps))).toEqual({ status: 'ok', identities: [{ ...linuxIdentity, state }] });
  });
});

describe('sameIdentity', () => {
  const bootCases = [BOOT, BOOT.toUpperCase(), '8B61301a-27f4-4828-9Ce1-9fc23BF14377'];

  it.each(bootCases)('compares UUID casing symmetrically for %s without mutating inputs', (bootId) => {
    const recorded = Object.freeze({ ...linuxIdentity, bootId });
    for (const observedBoot of bootCases) {
      const observed = Object.freeze({ ...linuxIdentity, bootId: observedBoot });
      expect(sameIdentity(recorded, observed)).toBe(true);
      expect(sameIdentity(observed, recorded)).toBe(true);
      expect(sameIdentity(recorded, { ...observed, bootId: OTHER_BOOT.toUpperCase() })).toBe(false);
    }
  });

  it.each(['linux', 'darwin'])('%s liveness accepts UUID casing differences through identity probes', (platform) => {
    const expected = platform === 'linux' ? linuxIdentity : darwinIdentity;
    for (const recordedBoot of bootCases) {
      for (const observedBoot of bootCases) {
        const deps = platform === 'linux'
          ? linuxDeps({ bootId: observedBoot }) : darwinDeps({ bootId: observedBoot });
        const recorded = { ...expected, bootId: recordedBoot };
        expect(liveness(recorded, deps)).toBe('alive');
        const group = listGroup(PID, deps);
        expect(group.status).toBe('ok');
        expect(group.identities).toHaveLength(1);
        expect(sameIdentity(recorded, group.identities[0])).toBe(true);
      }
    }
  });

  it('matches all four identity keys and ignores a state transition', () => {
    expect(sameIdentity(linuxIdentity, { ...linuxIdentity, state: 'R' })).toBe(true);
  });

  it.each([
    ['pid', PID + 1], ['startTime', '987655'], ['bootId', OTHER_BOOT], ['uid', UID + 1],
  ])('rejects a changed %s', (key, value) => {
    expect(sameIdentity(linuxIdentity, { ...linuxIdentity, [key]: value })).toBe(false);
  });
});

describe('liveness identity checks', () => {
  it.each(['linux', 'darwin'])('%s matching live identity is alive', (platform) => {
    expect(liveness(platform === 'linux' ? linuxIdentity : darwinIdentity,
      platform === 'linux' ? linuxDeps() : darwinDeps())).toBe('alive');
  });

  it.each([
    ['bootId', 'unreadable'], ['bootId', ''], ['bootId', undefined],
    ['startTime', 'unreadable'], ['startTime', ''], ['startTime', undefined],
    ['uid', undefined], ['pid', undefined],
  ])('invalid recorded %s (%s) stays unknown without probing', (key, value) => {
    const expected = { ...linuxIdentity, [key]: value };
    const deps = linuxDeps();
    expect(liveness(expected, deps)).toBe('unknown');
    expect(sameIdentity(expected, expected)).toBe(false);
    expect(deps.readFile).not.toHaveBeenCalled();
  });

  it('Linux pid reuse with a different start time is dead', () => {
    expect(liveness(linuxIdentity, linuxDeps({ processes: [{ pid: PID, startTime: '987655' }] }))).toBe('dead');
  });

  it('macOS pid reuse with a different lstart is dead', () => {
    expect(liveness(darwinIdentity, darwinDeps({ output: HEADER + psRow({ startTime: 'Wed Oct 29 13:30:00 2026' }) }))).toBe('dead');
  });

  it.each(['linux', 'darwin'])('%s boot id change is dead', (platform) => {
    const deps = platform === 'linux' ? linuxDeps({ bootId: OTHER_BOOT }) : darwinDeps({ bootId: OTHER_BOOT });
    expect(liveness(platform === 'linux' ? linuxIdentity : darwinIdentity, deps)).toBe('dead');
  });

  it.each(['linux', 'darwin'])('%s zombie fixture is dead even when identity matches', (platform) => {
    const deps = platform === 'linux'
      ? linuxDeps({ processes: [{ pid: PID, state: 'Z' }] })
      : darwinDeps({ output: HEADER + psRow({ state: 'Z+' }) });
    expect(liveness(platform === 'linux' ? linuxIdentity : darwinIdentity, deps)).toBe('dead');
  });

  it.each(['X', 'x'])('Linux dead state %s is never alive', (state) => {
    expect(liveness(linuxIdentity, linuxDeps({ processes: [{ pid: PID, state }] }))).toBe('dead');
  });

  it.each(['linux', 'darwin'])('%s real uid mismatch is dead', (platform) => {
    const deps = platform === 'linux'
      ? linuxDeps({ processes: [{ pid: PID, uid: UID + 1 }] })
      : darwinDeps({ output: HEADER + psRow({ uid: UID + 1 }) });
    expect(liveness(platform === 'linux' ? linuxIdentity : darwinIdentity, deps)).toBe('dead');
  });
});

describe('bounded probes fail closed', () => {
  it('exec ETIMEDOUT yields unknown rather than dead', () => {
    const deps = darwinDeps();
    deps.exec = vi.fn(() => { throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }); });
    expect(readIdentity(PID, deps)).toEqual({ status: 'unknown', reason: expect.any(String) });
    expect(liveness(darwinIdentity, deps)).toBe('unknown');
  });

  it.each([
    ['garbled', 'not a process row'],
    ['oversized', HEADER + psRow() + 'x'.repeat(2 * 1024 * 1024)],
  ])('%s ps output yields unknown rather than dead or alive', (_label, output) => {
    const deps = darwinDeps({ output });
    expect(readIdentity(PID, deps)).toEqual({ status: 'unknown', reason: expect.any(String) });
    expect(liveness(darwinIdentity, deps)).toBe('unknown');
  });

  it('garbled Linux stat yields unknown', () => {
    const deps = linuxDeps();
    const readFile = deps.readFile;
    deps.readFile = (path) => path.endsWith('/stat') ? `${PID} (broken) S 1` : readFile(path);
    expect(readIdentity(PID, deps)).toEqual({ status: 'unknown', reason: expect.any(String) });
    expect(liveness(linuxIdentity, deps)).toBe('unknown');
  });

  it('exec buffer exhaustion yields unknown', () => {
    const deps = darwinDeps();
    deps.exec = vi.fn(() => { throw Object.assign(new Error('maxBuffer exceeded'), { code: 'ENOBUFS' }); });
    expect(liveness(darwinIdentity, deps)).toBe('unknown');
  });

  it('ps and sysctl use argv arrays with positive timeout and maxBuffer bounds', () => {
    const deps = darwinDeps();
    expect(readIdentity(PID, deps).status).toBe('ok');
    expect(currentBootId(deps)).toBe(BOOT);
    expect(listGroup(PID, deps).status).toBe('ok');
    expect(deps.exec).toHaveBeenCalledWith('/bin/ps', ['-o', 'ruid,pid,ppid,pgid,stat,lstart', '-p', String(PID)], expect.any(Object));
    expect(deps.exec).toHaveBeenCalledWith('/bin/ps', ['-A', '-o', 'ruid,pid,ppid,pgid,stat,lstart'], expect.any(Object));
    expect(deps.exec).toHaveBeenCalledWith('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], expect.any(Object));
    deps.exec.mock.calls.forEach(([file, args, options]) => {
      expect(['/bin/ps', '/usr/sbin/sysctl']).toContain(file);
      expect(options.env).toMatchObject({ TZ: 'UTC', LC_ALL: 'C' });
      expect(Array.isArray(args)).toBe(true);
      expect(Number.isFinite(options.timeout)).toBe(true);
      expect(options.timeout).toBeGreaterThan(0);
      expect(options.timeout).toBeLessThanOrEqual(2000);
      expect(Number.isFinite(options.maxBuffer)).toBe(true);
      expect(options.maxBuffer).toBeGreaterThan(0);
      expect(options.maxBuffer).toBeLessThanOrEqual(1024 * 1024);
      expect(options.shell).toBe(false);
      expect(options.killSignal).toBe('SIGKILL');
    });
  });

  it.each(['stat', 'status'])('oversized Linux %s stays unknown throughout', (file) => {
    const deps = linuxDeps();
    const readFile = deps.readFile;
    deps.readFile = (path) => path.endsWith(`/${file}`) ? 'x'.repeat(1024 * 1024 + 1) : readFile(path);
    expect(readIdentity(PID, deps).status).toBe('unknown');
    expect(liveness(linuxIdentity, deps)).toBe('unknown');
    expect(listGroup(PID, deps).status).toBe('unknown');
  });
});

describe('currentBootId', () => {
  it.each(['linux', 'darwin'])('%s trims the boot id', (platform) => {
    expect(currentBootId(platform === 'linux' ? linuxDeps() : darwinDeps())).toBe(BOOT);
  });

  it.each(['linux', 'darwin'])('%s unreadable boot id returns null', (platform) => {
    const fail = () => { throw new Error('unavailable'); };
    expect(currentBootId({ platform, readFile: fail, exec: fail })).toBeNull();
  });

  it.each(['linux', 'darwin'])('%s missing or oversized boot evidence stays unknown', (platform) => {
    for (const bootId of ['', 'garbled', 'x'.repeat(1024 * 1024 + 1)]) {
      const deps = platform === 'linux' ? linuxDeps({ bootId }) : darwinDeps({ bootId });
      expect(currentBootId(deps)).toBeNull();
      expect(readIdentity(PID, deps).status).toBe('unknown');
      expect(liveness(platform === 'linux' ? linuxIdentity : darwinIdentity, deps)).toBe('unknown');
      expect(listGroup(PID, deps).status).toBe('unknown');
    }
  });
});

describe('listGroup', () => {
  it('Linux hidepid census omits live group -> listGroup unknown', () => {
    const deps = linuxDeps({ processes: [{ pid: 222, pgid: 222 }] });
    deps.kill = vi.fn(() => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); });
    expect(deps.readdir('/proc')).toEqual(['self', 'sys', '222']);
    expect(readIdentity(PID, deps)).toEqual({ status: 'unknown', reason: expect.any(String) });
    expect(deps.readFile).toHaveBeenCalledWith('/proc/12345/stat');
    deps.kill.mockClear();
    expect(listGroup(PID, deps)).toEqual({ status: 'unknown', reason: expect.any(String) });
    expect(deps.kill).toHaveBeenCalledWith(PID, 0);
  });

  it.each(['live', 'EPERM', 'EACCES', 'ESRCH'])('Linux omitted leader requires confirmed absence before returning visible members (%s)', (result) => {
    const deps = linuxDeps({ processes: [{ pid: PID + 1, pgid: PID }] });
    deps.kill = vi.fn(() => {
      if (result !== 'live') throw Object.assign(new Error(result), { code: result });
      return true;
    });
    expect(listGroup(PID, deps)).toEqual(result === 'ESRCH'
      ? { status: 'ok', identities: [{ ...linuxIdentity, pid: PID + 1 }] }
      : { status: 'unknown', reason: expect.any(String) });
    expect(deps.kill).toHaveBeenCalledWith(PID, 0);
  });

  it.each([
    ['before the target', [{ pid: 2, pgid: 0, uid: 0 }, { pid: PID }], [linuxIdentity]],
    ['after the target', [{ pid: PID }, { pid: 2, pgid: 0, uid: 0 }], [linuxIdentity]],
    ['without a target member', [{ pid: 2, pgid: 0, uid: 0 }], []],
  ])('Linux excludes a valid zero-group kernel thread %s', (_label, processes, identities) => {
    expect(listGroup(PID, linuxDeps({ processes }))).toEqual({ status: 'ok', identities });
  });

  it('Linux accepts a zero process group for identity reads while group queries require a positive id', () => {
    const deps = linuxDeps({ processes: [{ pid: 2, pgid: 0, uid: 0 }] });
    const identity = { ...linuxIdentity, pid: 2, uid: 0 };
    expect(readIdentity(2, deps)).toEqual({ status: 'ok', identity });
    expect(liveness(identity, deps)).toBe('alive');
    expect(listGroup(0, deps)).toEqual({ status: 'unknown', reason: 'Invalid process group' });
  });

  it.each([-1, '1e4', '9007199254740992'])('Linux malformed unrelated process group %s invalidates the census', (pgid) => {
    const deps = linuxDeps({ processes: [{ pid: PID }, { pid: 2, pgid, uid: 0 }] });
    expect(listGroup(PID, deps)).toEqual({ status: 'unknown', reason: expect.any(String) });
  });

  it.each(['', HEADER])('an empty macOS all-process census is unknown, not an empty group', (output) => {
    expect(listGroup(PID, darwinDeps({ output }))).toEqual({ status: 'unknown', reason: expect.any(String) });
  });

  it('an unreadable Linux member invalidates the whole group snapshot', () => {
    const deps = linuxDeps({ processes: [{ pid: PID }, { pid: PID + 1 }] });
    const readFile = deps.readFile;
    deps.readFile = (path) => {
      if (path === `/proc/${PID + 1}/status`) throw new Error('denied');
      return readFile(path);
    };
    expect(listGroup(PID, deps)).toEqual({ status: 'unknown', reason: expect.any(String) });
  });

  it.each(['live', 'EPERM', 'ESRCH'])('Linux missing group member needs confirmed absence (%s)', (result) => {
    const deps = linuxDeps();
    const readFile = deps.readFile;
    deps.readFile = (path) => {
      if (path.endsWith('/stat')) throw enoent();
      return readFile(path);
    };
    deps.kill = vi.fn(() => {
      if (result !== 'live') throw Object.assign(new Error(result), { code: result });
      return true;
    });
    expect(listGroup(PID, deps)).toEqual(result === 'ESRCH'
      ? { status: 'ok', identities: [] }
      : { status: 'unknown', reason: expect.any(String) });
    expect(deps.kill).toHaveBeenCalledWith(PID, 0);
  });

  it.each(['garbled', 'x'.repeat(1024 * 1024 + 1)])('incomplete macOS group output fails closed', (output) => {
    expect(listGroup(PID, darwinDeps({ output })).status).toBe('unknown');
  });

  it('an oversized procfs directory fails closed', () => {
    const deps = linuxDeps();
    deps.readdir = () => Array(65537).fill(String(PID));
    expect(listGroup(PID, deps).status).toBe('unknown');
  });

  it('Linux scans procfs and includes only identities in the requested pgid, with their own uids', () => {
    const deps = linuxDeps({ processes: [{ pid: PID }, { pid: PID + 1, pgid: PID, uid: 502 }, { pid: PID + 2, pgid: 77 }] });
    const result = listGroup(PID, deps);
    expect(result.status).toBe('ok');
    expect(result.identities).toHaveLength(2);
    expect(result.identities).toEqual(expect.arrayContaining([linuxIdentity, { ...linuxIdentity, pid: PID + 1, uid: 502 }]));
    expect(deps.readdir).toHaveBeenCalledWith('/proc');
    expect(deps.exec).not.toHaveBeenCalled();
  });

  it('macOS filters ps rows by pgid and preserves member identity', () => {
    const deps = darwinDeps({ output: HEADER + psRow() + psRow({ pid: PID + 1, pgid: PID, uid: 502 }) + psRow({ pid: PID + 2, pgid: 77 }) });
    const result = listGroup(PID, deps);
    expect(result.status).toBe('ok');
    expect(result.identities).toHaveLength(2);
    expect(result.identities).toEqual(expect.arrayContaining([darwinIdentity, { ...darwinIdentity, pid: PID + 1, uid: 502 }]));
  });

  it('unreadable Linux directory returns unknown with a reason', () => {
    const deps = linuxDeps();
    deps.readdir = () => { throw new Error('denied'); };
    expect(listGroup(PID, deps)).toEqual({ status: 'unknown', reason: expect.any(String) });
  });

  it('macOS group probe timeout returns unknown with a reason', () => {
    const deps = darwinDeps();
    const exec = deps.exec;
    deps.exec = vi.fn((file, ...args) => {
      if (file === '/bin/ps') throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
      return exec(file, ...args);
    });
    expect(listGroup(PID, deps)).toEqual({ status: 'unknown', reason: expect.any(String) });
    expect(deps.exec).toHaveBeenCalledWith('/bin/ps', ['-A', '-o', 'ruid,pid,ppid,pgid,stat,lstart'], expect.any(Object));
  });
});

describe('bounded filesystem adapters', () => {
  const maxBytes = 1024 * 1024;
  // Native ESM consumers can bypass Vitest's node:fs module mock. Inject only
  // these adapters' IO so instrumentation also reaches the production reader.
  const io = Object.fromEntries(['openSync', 'readSync', 'closeSync', 'opendirSync']
    .map((name) => [name, vi.fn(fs[name])]));
  const { openSync, readSync, closeSync, opendirSync } = io;
  afterEach(() => {
    for (const [name, mock] of Object.entries(io)) {
      mock.mockReset().mockImplementation(fs[name]);
    }
  });

  it('default adapters read real files and directory entries without injected IO', () => {
    const root = mkdtempSync(join(tmpdir(), 'proc-identity-'));
    const path = join(root, 'evidence');
    try {
      writeFileSync(path, 'process evidence');
      expect(boundedReadFile(path)).toBe('process evidence');
      expect(boundedReaddir(root)).toEqual(['evidence']);
      for (const mock of Object.values(io)) expect(mock).not.toHaveBeenCalled();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('procfs reader reads at most MAX_BYTES plus one byte and closes on rejection', () => {
    const root = mkdtempSync(join(tmpdir(), 'proc-identity-'));
    const path = join(root, 'large');
    writeFileSync(path, Buffer.alloc(maxBytes * 2, 120));
    const nativeRead = readSync.getMockImplementation();
    let total = 0;
    const ranges = [];
    readSync.mockImplementation((fd, buffer, offset, length, position) => {
      ranges.push({ offset, length, capacity: buffer.length });
      const count = nativeRead(fd, buffer, offset, Math.min(length, 65536), position);
      total += count;
      return count;
    });
    closeSync.mockClear();
    try {
      expect(() => boundedReadFile(path, io)).toThrow(/1 MiB/);
      expect(total).toBe(maxBytes + 1);
      expect(ranges.length).toBeGreaterThan(1);
      for (const range of ranges) {
        expect(range.capacity).toBe(maxBytes + 1);
        expect(range.offset + range.length).toBe(maxBytes + 1);
      }
      expect(closeSync).toHaveBeenCalledTimes(1);
      expect(() => nativeRead(closeSync.mock.calls[0][0], Buffer.alloc(1), 0, 1, null)).toThrow();
    } finally {
      readSync.mockImplementation(nativeRead);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reader accepts exactly MAX_BYTES and closes on successful EOF', () => {
    const root = mkdtempSync(join(tmpdir(), 'proc-identity-'));
    const path = join(root, 'exact');
    writeFileSync(path, 'x'.repeat(maxBytes));
    closeSync.mockClear();
    try {
      expect(boundedReadFile(path, io)).toBe('x'.repeat(maxBytes));
      expect(closeSync).toHaveBeenCalledTimes(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('procfs reader honours deadline between reads and closes on timeout', () => {
    const nativeRead = readSync.getMockImplementation();
    const clock = vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(2000);
    openSync.mockReturnValueOnce(987);
    readSync.mockImplementationOnce(() => 1).mockImplementation(() => { throw new Error('Unexpected second read'); });
    closeSync.mockImplementationOnce(() => {});
    readSync.mockClear();
    closeSync.mockClear();
    try {
      expect(() => boundedReadFile('/synthetic', io)).toThrow(/timed out/);
      expect(readSync).toHaveBeenCalledTimes(1);
      expect(closeSync).toHaveBeenCalledWith(987);
    } finally { clock.mockRestore(); readSync.mockImplementation(nativeRead); }
  });

  it('procfs reader closes when the filesystem read throws', () => {
    openSync.mockReturnValueOnce(987);
    readSync.mockImplementationOnce(() => { throw new Error('read failed'); });
    closeSync.mockImplementationOnce(() => {});
    closeSync.mockClear();
    expect(() => boundedReadFile('/synthetic', io)).toThrow('read failed');
    expect(closeSync).toHaveBeenCalledWith(987);
  });

  it.each([65536, 65537])('directory reader enforces the 65536 entry cap (%s)', (count) => {
    let seen = 0;
    const dir = { readSync: vi.fn(() => seen++ < count ? { name: String(seen) } : null), closeSync: vi.fn() };
    opendirSync.mockReturnValueOnce(dir);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(0);
    try {
      if (count === 65536) expect(boundedReaddir('/synthetic', io)).toHaveLength(count);
      else expect(() => boundedReaddir('/synthetic', io)).toThrow(/scan limit/);
      expect(dir.readSync.mock.calls.length).toBeLessThanOrEqual(65537);
      expect(dir.closeSync).toHaveBeenCalledTimes(1);
    } finally { clock.mockRestore(); }
  });

  it('directory reader honours deadline and closes on timeout', () => {
    const dir = { readSync: vi.fn(() => ({ name: '1' })), closeSync: vi.fn() };
    opendirSync.mockReturnValueOnce(dir);
    const clock = vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(2000);
    try {
      expect(() => boundedReaddir('/synthetic', io)).toThrow(/scan limit/);
      expect(dir.readSync).toHaveBeenCalledTimes(1);
      expect(dir.closeSync).toHaveBeenCalledTimes(1);
    } finally { clock.mockRestore(); }
  });
});

describe('real host process identity', () => {
  it.skipIf(!['linux', 'darwin'].includes(process.platform))('a REAL exited pid reads gone and dead on darwin and linux', async () => {
    const child = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { stdio: ['pipe', 'ignore', 'ignore'] });
    try {
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      const before = readIdentity(child.pid);
      expect(before.status).toBe('ok');
      const exited = new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
      child.stdin.end();
      await exited;
      expect(readIdentity(child.pid)).toEqual({ status: 'gone' });
      expect(liveness(before.identity)).toBe('dead');
    } finally {
      child.stdin.destroy();
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  });

  it.skipIf(process.platform === 'win32')('a real live process is alive and has the same identity across reads', () => {
    const first = readIdentity(process.pid);
    const second = readIdentity(process.pid);
    expect(first.status).toBe('ok');
    expect(second.status).toBe('ok');
    expect(sameIdentity(first.identity, second.identity)).toBe(true);
    expect(liveness({ ...first.identity })).toBe('alive');
  });

  it.skipIf(process.platform === 'win32')('a REAL zombie reads dead on the real host', async () => {
    const parent = spawn('sh', ['-c', 'true & echo $!; exec sleep 30'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let timer;
    try {
      const pid = await new Promise((resolve, reject) => {
        let output = '';
        timer = setTimeout(() => reject(new Error('No zombie pid printed within 2s')), 2000);
        parent.once('error', reject);
        parent.stdout.on('data', (chunk) => {
          output += chunk.toString();
          if (output.includes('\n')) {
            clearTimeout(timer);
            const value = Number(output.trim());
            if (Number.isInteger(value) && value > 0) resolve(value);
            else reject(new Error('Invalid zombie pid'));
          }
        });
      });
      const deadline = Date.now() + 20000;
      const waitForZombie = async () => {
        const result = readIdentity(pid);
        if (result.status === 'ok' && result.identity.state === 'Z') return result.identity;
        if (Date.now() >= deadline) throw new Error(`Zombie state not observed within 20s: ${JSON.stringify(result)}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
        return waitForZombie();
      };
      const identity = await waitForZombie();
      expect(identity.state).toBe('Z');
      expect(liveness({ ...identity })).toBe('dead');
    } finally {
      clearTimeout(timer);
      if (parent.pid) {
        try { process.kill(parent.pid, 'SIGKILL'); } catch (error) {
          if (error.code !== 'ESRCH') throw error;
        }
      }
    }
  }, 30000);
});
