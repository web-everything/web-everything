import { describe, it, expect, vi, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import fs, { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readIdentity, sameIdentity, liveness, currentBootId, listGroup, boundedReadFile, boundedReaddir, record, probe } from '../proc-identity.mjs';

const PID = 12345;
const UID = 501;
const BOOT = '8b61301a-27f4-4828-9ce1-9fc23bf14377';
const OTHER_BOOT = '7b61301a-27f4-4828-9ce1-9fc23bf14377';
const START = 'Tue Oct 28 13:30:00 2026';
const HEADER = ' RUID   PID  PPID  PGID STAT                  STARTED\n';
const enoent = () => Object.assign(new Error('missing process'), { code: 'ENOENT' });

function stat({ pid = PID, pgid = PID, startTime = '987654', state = 'S', ppid = 1 } = {}) {
  // Fields 3–22: state, ppid, pgrp, fields 6–21, starttime. The final ')' ends comm.
  return `${pid} (worker ) with spaces (nested)) ${[state, ppid, pgid, ...Array(16).fill(0), startTime].join(' ')}\n`;
}

function psRow({ pid = PID, pgid = PID, uid = UID, state = 'Ss', startTime = START } = {}) {
  return `  ${uid} ${pid} 1 ${pgid} ${state}   ${startTime}\n`;
}

function procMount(options = 'rw') {
  return `36 25 0:32 / /proc rw,nosuid,nodev,noexec,relatime - proc proc ${options}\n`;
}

function linuxDeps({ processes = [{ pid: PID }], bootId = BOOT, mountinfo = procMount() } = {}) {
  const files = new Map([
    ['/proc/sys/kernel/random/boot_id', ` ${bootId}\n`],
    ['/proc/self/mountinfo', mountinfo],
  ]);
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

describe('Linux procfs census visibility', () => {
  it('visible leader with a hidepid-hidden mixed-UID member makes listGroup unknown', () => {
    const hiddenPid = PID + 1;
    const deps = linuxDeps({
      processes: [{ pid: PID }, { pid: hiddenPid, pgid: PID, uid: UID + 1 }],
      mountinfo: procMount('rw,hidepid=2'),
    });
    deps.readdir = vi.fn(() => ['self', 'sys', String(PID)]);
    const read = deps.readFile;
    deps.readFile = (path) => {
      if (path.startsWith(`/proc/${hiddenPid}/`)) throw enoent();
      return read(path);
    };
    deps.kill = vi.fn(() => { throw Object.assign(new Error('hidden member'), { code: 'EPERM' }); });
    expect(readIdentity(PID, deps)).toEqual({ status: 'ok', identity: linuxIdentity });
    expect(deps.readdir('/proc')).toEqual(['self', 'sys', String(PID)]);
    expect(listGroup(PID, deps)).toEqual({ status: 'unknown', reason: expect.any(String) });
  });

  it.each(['1', '2', '4', 'noaccess', 'invisible', 'ptraceable', 'garbled'])('hidepid=%s cannot certify a complete census', (mode) => {
    expect(listGroup(PID, linuxDeps({ mountinfo: procMount(`rw,hidepid=${mode}`) })))
      .toEqual({ status: 'unknown', reason: expect.any(String) });
  });

  it.each(['rw', 'rw,hidepid=0'])('unrestricted procfs (%s) permits a complete mixed-UID census', (options) => {
    const deps = linuxDeps({
      processes: [{ pid: PID }, { pid: PID + 1, pgid: PID, uid: UID + 1 }],
      mountinfo: procMount(options),
    });
    expect(listGroup(PID, deps)).toEqual({ status: 'ok', identities: [
      linuxIdentity, { ...linuxIdentity, pid: PID + 1, uid: UID + 1 },
    ] });
    expect(deps.readFile.mock.calls.filter(([path]) => path === '/proc/self/mountinfo')).toHaveLength(2);
  });

  it.each([
    ['empty', ''],
    ['malformed', 'garbled'],
    ['missing proc mount', procMount().replace(' /proc ', ' /elsewhere ')],
    ['partial mount root', procMount().replace(' / /proc ', ' /restricted /proc ')],
    ['wrong filesystem', procMount().replace(' - proc proc ', ' - tmpfs tmpfs ')],
    ['ambiguous mounts', procMount() + procMount('rw,hidepid=2')],
    ['bare hidepid', procMount('rw,hidepid')],
    ['oversized', 'x'.repeat(1024 * 1024 + 1)],
  ])('%s mount evidence fails closed; retry or inspect mount configuration manually', (_label, mountinfo) => {
    expect(listGroup(PID, linuxDeps({ mountinfo })))
      .toEqual({ status: 'unknown', reason: expect.any(String) });
  });

  it.each(['ENOENT', 'EACCES', 'EPERM'])('unreadable mount evidence (%s) stays unknown', (code) => {
    const deps = linuxDeps();
    const read = deps.readFile;
    deps.readFile = (path) => {
      if (path === '/proc/self/mountinfo') throw Object.assign(new Error('mount evidence unavailable'), { code });
      return read(path);
    };
    expect(listGroup(PID, deps)).toEqual({ status: 'unknown', reason: expect.any(String) });
  });

  it.each(['hidden', 'changed mount', 'unreadable'])('mount evidence becoming %s during the census stays unknown', (change) => {
    const deps = linuxDeps();
    const read = deps.readFile;
    let reads = 0;
    deps.readFile = (path) => {
      if (path === '/proc/self/mountinfo' && ++reads > 1) {
        if (change === 'unreadable') throw new Error('mount evidence lost');
        return change === 'hidden' ? procMount('rw,hidepid=2') : procMount().replace('36 25', '37 25');
      }
      return read(path);
    };
    expect(listGroup(PID, deps)).toEqual({ status: 'unknown', reason: expect.any(String) });
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
    openSync.mockClear();
    try {
      expect(() => boundedReadFile(path, io)).toThrow(/1 MiB/);
      expect(total).toBe(maxBytes + 1);
      expect(ranges.length).toBeGreaterThan(1);
      for (const range of ranges) {
        expect(range.capacity).toBe(maxBytes + 1);
        expect(range.offset + range.length).toBe(maxBytes + 1);
      }
      expect(closeSync).toHaveBeenCalledTimes(1);
      // Deterministic: the fd that was closed is exactly the fd that was opened.
      // (Probing the closed fd with a real read is racy: the kernel may hand the
      // same fd number to another open in the worker, so the read succeeds.)
      expect(closeSync.mock.calls[0][0]).toBe(openSync.mock.results[0].value);
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
      expect(probe(before.identity)).toEqual(outcome('dead', 'gone'));
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
    const captured = record(process.pid);
    expect(captured.ok).toBe(true);
    expect(probe(captured.identity)).toEqual(outcome('alive'));
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


// Extra evidence for the new API; legacy fixtures intentionally retain their old shape.
const PID_NS = 'pid:[4026531836]';
function singleDeps(platform = 'linux', options = {}) {
  if (platform === 'darwin') return darwinDeps(options);
  const deps = linuxDeps(options);
  const read = deps.readFile;
  deps.readFile = (path) => {
    if (path === `/proc/${PID}/cmdline`) return 'worker\0';
    if (path === `/proc/${PID}/task/${PID}/stat`) return stat(options.processes?.[0]);
    return read(path);
  };
  deps.readlink = vi.fn((path) => {
    if (path === `/proc/${PID}/ns/pid`) return PID_NS;
    if (path === `/proc/${PID}/exe`) return '/usr/bin/worker';
    throw enoent();
  });
  deps.readdir = vi.fn(() => [String(PID)]);
  return deps;
}
const expectedFor = (platform) => platform === 'linux'
  ? { ...linuxIdentity, pidNs: PID_NS } : darwinIdentity;
const outcome = (state, reason = expect.stringMatching(/^[a-z][a-z0-9-]*$/)) => ({ state, reason });
function replaceRead(deps, suffix, replacement) {
  const read = deps.readFile;
  deps.readFile = (path) => path.endsWith(suffix) ? replacement(path) : read(path);
}
const denied = () => { throw Object.assign(new Error('unavailable'), { code: 'EACCES' }); };

function singleDepsWithStatChange(after) {
  const deps = singleDeps();
  const read = deps.readFile;
  const statReads = vi.fn()
    .mockImplementationOnce(() => stat())
    .mockImplementation(() => stat(after));
  deps.readFile = (path) => path === `/proc/${PID}/stat` ? statReads() : read(path);
  return { deps, statReads };
}

describe('single-pid identity changes during read', () => {
  const changes = [
    ['startTime', { startTime: '987655' }],
    ['ppid', { ppid: 42 }],
    ['startTime and ppid', { startTime: '987655', ppid: 42 }],
  ];
  it.each(changes)('record refuses a changed %s on the second stat read', (_, after) => {
    const { deps, statReads } = singleDepsWithStatChange(after);
    expect(record(PID, deps)).toEqual({ ok: false, reason: 'identity-changed-during-read' });
    expect(statReads).toHaveBeenCalledTimes(2);
  });
  it.each(changes)('probe stays unknown for a changed %s on the second stat read', (_, after) => {
    const { deps, statReads } = singleDepsWithStatChange(after);
    expect(probe(expectedFor('linux'), deps)).toEqual(outcome('unknown', 'identity-changed-during-read'));
    expect(statReads).toHaveBeenCalledTimes(2);
  });
  it.each(['Z', 'X', 'x'])('record captures the same identity after a mid-read transition to %s without state', (state) => {
    const { deps, statReads } = singleDepsWithStatChange({ state });
    expect(record(PID, deps)).toEqual({ ok: true, identity: {
      pid: PID, startTime: '987654', bootId: BOOT, pidNs: PID_NS, uid: UID,
    } });
    expect(statReads).toHaveBeenCalledTimes(2);
  });
  it.each(['Z', 'X', 'x'])('probe is dead after a mid-read transition to %s with all tasks exited', (state) => {
    const { deps, statReads } = singleDepsWithStatChange({ state });
    replaceRead(deps, `/task/${PID}/stat`, () => stat({ state }));
    expect(probe(expectedFor('linux'), deps)).toEqual(outcome('dead', 'exited'));
    expect(statReads).toHaveBeenCalledTimes(2);
    expect(deps.readdir).toHaveBeenCalledWith(`/proc/${PID}/task`);
  });
  it.each(['Z', 'X', 'x'])('probe stays unknown after a mid-read transition to %s with a live task', (state) => {
    const { deps, statReads } = singleDepsWithStatChange({ state });
    // The default task fixture is still live even though the leader has exited.
    expect(probe(expectedFor('linux'), deps)).toEqual(outcome('unknown', 'zombie-leader-live-tasks'));
    expect(statReads).toHaveBeenCalledTimes(2);
    expect(deps.readdir).toHaveBeenCalledWith(`/proc/${PID}/task`);
  });
});

describe('single-pid tri-state probe', () => {
  it.each(['linux', 'darwin'])('%s alive key match', (platform) => {
    expect(probe(expectedFor(platform), singleDeps(platform))).toEqual(outcome('alive'));
  });
  it('Linux confirmed ENOENT plus ESRCH is dead', () => {
    expect(probe(linuxIdentity, singleDeps('linux', { processes: [] }))).toEqual(outcome('dead', 'gone'));
  });
  it.each(['linux', 'darwin'])('%s empty process query is dead', (platform) => {
    const deps = singleDeps(platform, platform === 'linux' ? { processes: [] } : { output: '' });
    expect(probe(expectedFor(platform), deps)).toEqual(outcome('dead', 'gone'));
  });
  it.each(['linux', 'darwin'])('%s different startTime is pid reuse', (platform) => {
    const deps = singleDeps(platform, platform === 'linux'
      ? { processes: [{ pid: PID, startTime: '987655' }] }
      : { output: HEADER + psRow({ startTime: 'Wed Oct 29 13:30:00 2026' }) });
    expect(probe(expectedFor(platform), deps)).toEqual(outcome('dead', 'pid-reused'));
  });
  it.each(['linux', 'darwin'])('%s different bootId is dead', (platform) => {
    expect(probe(expectedFor(platform), singleDeps(platform, { bootId: OTHER_BOOT })))
      .toEqual(outcome('dead', 'pid-reused'));
  });
  it.each(['linux', 'darwin'])('%s uppercase observed bootId is equal', (platform) => {
    expect(probe(expectedFor(platform), singleDeps(platform, { bootId: BOOT.toUpperCase() }))).toEqual(outcome('alive'));
  });
  it('different pidNs is dead', () => {
    expect(probe({ ...linuxIdentity, pidNs: 'pid:[99]' }, singleDeps())).toEqual(outcome('dead', 'pid-reused'));
  });
  it('legacy expected without pidNs still matches', () => {
    expect(probe(linuxIdentity, singleDeps())).toEqual(outcome('alive'));
  });
  it('hidepid ENOENT with kill EPERM stays unknown', () => {
    const deps = singleDeps('linux', { processes: [] });
    deps.kill = () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); };
    expect(probe(linuxIdentity, deps)).toEqual(outcome('unknown'));
  });
  it('EPERM evidence never yields alive', () => {
    const deps = singleDeps();
    replaceRead(deps, '/stat', () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); });
    expect(probe(linuxIdentity, deps)).toEqual(outcome('unknown'));
  });
  it('unreadable stat stays unknown', () => {
    const deps = singleDeps();
    replaceRead(deps, '/stat', denied);
    expect(probe(linuxIdentity, deps)).toEqual(outcome('unknown'));
  });
  it('garbled stat stays unknown', () => {
    const deps = singleDeps();
    replaceRead(deps, '/stat', () => 'garbled');
    expect(probe(linuxIdentity, deps)).toEqual(outcome('unknown'));
  });
  it('ps timeout stays unknown', () => {
    const deps = singleDeps('darwin');
    const exec = deps.exec;
    deps.exec = (file, ...args) => {
      if (file === '/bin/ps') throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
      return exec(file, ...args);
    };
    expect(probe(darwinIdentity, deps)).toEqual(outcome('unknown', 'evidence-unavailable'));
  });
  it.each(['linux', 'darwin'])('%s boot id unavailable stays unknown, including absent pid', (platform) => {
    for (const absent of [false, true]) {
      const deps = singleDeps(platform, { bootId: '', ...(absent ? platform === 'linux' ? { processes: [] } : { output: '' } : {}) });
      expect(probe(expectedFor(platform), deps)).toEqual(outcome('unknown', 'boot-id-unavailable'));
    }
  });
  it('unsupported platform stays unknown', () => {
    expect(probe(linuxIdentity, { platform: 'freebsd' })).toEqual(outcome('unknown', 'unsupported-platform'));
  });
  it.each([null, undefined, {}, { ...linuxIdentity, pid: -1 }, { ...linuxIdentity, bootId: 'bad' },
    { ...linuxIdentity, startTime: '' }, { ...linuxIdentity, pidNs: '' }, { ...linuxIdentity, uid: -1 }])('invalid expected %j stays unknown', (expected) => {
    expect(probe(expected, singleDeps())).toEqual(outcome('unknown', 'invalid-expected'));
  });
  it('zombie leader with live task stays unknown', () => {
    const deps = singleDeps('linux', { processes: [{ pid: PID, state: 'Z' }] });
    deps.readdir = () => [String(PID), String(PID + 1)];
    replaceRead(deps, `/task/${PID + 1}/stat`, () => stat({ pid: PID + 1 }));
    expect(probe(linuxIdentity, deps)).toEqual(outcome('unknown', 'zombie-leader-live-tasks'));
  });
  it.each(['Z', 'X', 'x'])('leader %s with all tasks exited is dead', (state) => {
    expect(probe(linuxIdentity, singleDeps('linux', { processes: [{ pid: PID, state }] })))
      .toEqual(outcome('dead', 'exited'));
  });
  it.each(['Z', 'X', 'x'])('a worker spawning a successor before exiting to %s cannot prove process exit', (state) => {
    const deps = singleDeps();
    const captured = record(PID, deps);
    expect(captured.ok).toBe(true);
    replaceRead(deps, `/proc/${PID}/stat`, () => stat({ state: 'Z' }));
    replaceRead(deps, `/task/${PID}/stat`, () => stat({ state: 'Z' }));
    let spawned = false;
    deps.readdir = vi.fn(() => spawned
      ? [String(PID), String(PID + 1), String(PID + 2)]
      : [String(PID), String(PID + 1)]);
    replaceRead(deps, `/task/${PID + 1}/stat`, () => {
      spawned = true; // The old worker is retained as a zombie after creating its successor.
      return stat({ pid: PID + 1, state });
    });
    replaceRead(deps, `/task/${PID + 2}/stat`, () => stat({ pid: PID + 2, state: 'S' }));
    expect(probe(captured.identity, deps)).toEqual(outcome('unknown', 'evidence-unavailable'));
    expect(deps.readdir).toHaveBeenCalledTimes(2);
    expect(deps.readdir()).toEqual([String(PID), String(PID + 1), String(PID + 2)]);
    expect(deps.readFile(`/proc/${PID}/task/${PID + 2}/stat`)).toBe(stat({ pid: PID + 2, state: 'S' }));
  });
  it.each([
    ['same-count replacement', [String(PID), String(PID + 2)]],
    ['removed task', [String(PID)]],
    ['empty', []],
    ['malformed', [String(PID), 'bad']],
    ['duplicate', [String(PID), String(PID)]],
    ['non-array', null],
    ['oversized', Array(65537).fill(String(PID))],
  ])('a %s final task census stays unknown', (_kind, finalNames) => {
    const deps = singleDeps('linux', { processes: [{ pid: PID, state: 'Z' }] });
    replaceRead(deps, `/task/${PID + 1}/stat`, () => stat({ pid: PID + 1, state: 'Z' }));
    deps.readdir = vi.fn()
      .mockReturnValueOnce([String(PID), String(PID + 1)])
      .mockReturnValue(finalNames);
    expect(probe(linuxIdentity, deps)).toEqual(outcome('unknown', 'evidence-unavailable'));
  });
  it.each(['ENOENT', 'ESRCH', 'EACCES', 'EPERM'])('a final task census failing with %s stays unknown', (code) => {
    const deps = singleDeps('linux', { processes: [{ pid: PID, state: 'Z' }] });
    deps.readdir = vi.fn().mockReturnValueOnce([String(PID)]).mockImplementation(() => {
      throw Object.assign(new Error('final census unavailable'), { code });
    });
    expect(probe(linuxIdentity, deps)).toEqual(outcome('unknown', 'evidence-unavailable'));
  });
  it('an unchanged task set in a different order still proves exit', () => {
    const deps = singleDeps('linux', { processes: [{ pid: PID, state: 'Z' }] });
    replaceRead(deps, `/task/${PID + 1}/stat`, () => stat({ pid: PID + 1, state: 'Z' }));
    deps.readdir = vi.fn()
      .mockReturnValueOnce([String(PID), String(PID + 1)])
      .mockReturnValue([String(PID + 1), String(PID)]);
    expect(probe(linuxIdentity, deps)).toEqual(outcome('dead', 'exited'));
    expect(deps.readdir).toHaveBeenCalledTimes(2);
  });
  it('duplicate initial task IDs cannot establish a complete census', () => {
    const deps = singleDeps('linux', { processes: [{ pid: PID, state: 'Z' }] });
    deps.readdir = () => [String(PID), String(PID)];
    expect(probe(linuxIdentity, deps)).toEqual(outcome('unknown', 'evidence-unavailable'));
  });
  it('a stable final task census exceeding the scan deadline stays unknown', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(0);
    try {
      const deps = singleDeps('linux', { processes: [{ pid: PID, state: 'Z' }] });
      deps.readdir = vi.fn().mockReturnValueOnce([String(PID)]).mockImplementation(() => {
        clock.mockReturnValue(2000);
        return [String(PID)];
      });
      expect(probe(linuxIdentity, deps)).toEqual(outcome('unknown', 'evidence-unavailable'));
    } finally {
      clock.mockRestore();
    }
  });
  it.each(['ENOENT', 'EACCES', 'EPERM'])('zombie namespace link %s with all-Z tasks is dead', (code) => {
    const deps = singleDeps('linux', { processes: [{ pid: PID, state: 'Z' }] });
    deps.readlink = vi.fn(() => { throw Object.assign(new Error('namespace unavailable'), { code }); });
    expect(probe(expectedFor('linux'), deps)).toEqual(outcome('dead', 'exited'));
    expect(deps.readlink).not.toHaveBeenCalled();
    expect(record(PID, deps)).toEqual({ ok: false, reason: 'evidence-unavailable' });
  });
  it('zombie namespace link ENOENT with a live task stays unknown', () => {
    const deps = singleDeps('linux', { processes: [{ pid: PID, state: 'Z' }] });
    deps.readlink = vi.fn(() => { throw enoent(); });
    deps.readdir = () => [String(PID), String(PID + 1)];
    replaceRead(deps, `/task/${PID + 1}/stat`, () => stat({ pid: PID + 1 }));
    expect(probe(expectedFor('linux'), deps)).toEqual(outcome('unknown', 'zombie-leader-live-tasks'));
    expect(deps.readlink).not.toHaveBeenCalled();
  });
  it('zombie with task directory gone is dead', () => {
    const deps = singleDeps('linux', { processes: [{ pid: PID, state: 'Z' }] });
    deps.readdir = () => { throw enoent(); };
    expect(probe(linuxIdentity, deps)).toEqual(outcome('dead', 'exited'));
  });
  it.each(['ENOENT', 'ESRCH'].flatMap((code) =>
    ['live', 'EPERM', 'EACCES', 'EIO', 'ESRCH'].map((signal) => [code, signal])))
  ('missing zombie task directory (%s) requires confirmed absence (%s)', (code, signal) => {
    const deps = singleDeps('linux', { processes: [{ pid: PID, state: 'Z' }] });
    // Matching leader evidence remains readable until hidepid conceals the census.
    // A live worker cannot be ruled out by the directory error alone.
    deps.readdir = vi.fn(() => { throw Object.assign(new Error('task directory hidden'), { code }); });
    deps.kill = vi.fn(() => {
      if (signal !== 'live') throw Object.assign(new Error('signal check'), { code: signal });
    });
    expect(probe(expectedFor('linux'), deps)).toEqual(signal === 'ESRCH'
      ? outcome('dead', 'exited') : outcome('unknown', 'evidence-unavailable'));
    expect(deps.readdir).toHaveBeenCalledWith(`/proc/${PID}/task`);
    expect(deps.kill).toHaveBeenCalledWith(PID, 0);
  });
  it('unreadable zombie tasks stays unknown', () => {
    const deps = singleDeps('linux', { processes: [{ pid: PID, state: 'Z' }] });
    deps.readdir = denied;
    expect(probe(linuxIdentity, deps)).toEqual(outcome('unknown'));
  });
  it('missing status cannot masquerade as confirmed process absence', () => {
    const deps = singleDeps();
    replaceRead(deps, '/status', () => { throw enoent(); });
    expect(probe(linuxIdentity, deps)).toEqual(outcome('unknown'));
  });
  it.each(['', 'pid:[oops]', 'x'.repeat(1024 * 1024 + 1)])('malformed or oversized namespace fails closed (%#)', (link) => {
    const deps = singleDeps();
    deps.readlink = () => link;
    expect(probe(linuxIdentity, deps)).toEqual(outcome('unknown'));
    expect(record(PID, deps)).toEqual({ ok: false, reason: expect.any(String) });
  });
  it('unreadable exe with empty cmdline is unknown, not kernel-thread evidence', () => {
    const deps = singleDeps();
    replaceRead(deps, '/cmdline', () => '');
    const link = deps.readlink;
    deps.readlink = (path) => path.endsWith('/exe') ? denied() : link(path);
    expect(probe(linuxIdentity, deps)).toEqual(outcome('unknown', 'evidence-unavailable'));
  });
  it('empty task enumeration is incomplete evidence', () => {
    const deps = singleDeps('linux', { processes: [{ pid: PID, state: 'Z' }] });
    deps.readdir = () => [];
    expect(probe(linuxIdentity, deps)).toEqual(outcome('unknown'));
  });
  it('unreadable individual zombie task cannot prove all tasks exited', () => {
    const deps = singleDeps('linux', { processes: [{ pid: PID, state: 'Z' }] });
    replaceRead(deps, `/task/${PID}/stat`, () => { throw enoent(); });
    expect(probe(linuxIdentity, deps)).toEqual(outcome('unknown'));
  });
  it('PID 2 remains a kernel thread when its stat is hidden', () => {
    const deps = singleDeps('linux', { processes: [] });
    expect(probe({ ...linuxIdentity, pid: 2 }, deps)).toEqual(outcome('unknown', 'kernel-thread'));
  });
  it('macOS Z is dead', () => {
    expect(probe(darwinIdentity, singleDeps('darwin', { output: HEADER + psRow({ state: 'Z' }) })))
      .toEqual(outcome('dead', 'exited'));
  });
  it.each(['linux', 'darwin'])('%s uppercase expected bootId still matches', (platform) => {
    expect(probe({ ...expectedFor(platform), bootId: BOOT.toUpperCase() }, singleDeps(platform))).toEqual(outcome('alive'));
  });
  it.each(['linux', 'darwin'])('%s differing uid is a filter, not an identity key', (platform) => {
    expect(probe({ ...expectedFor(platform), uid: UID + 1 }, singleDeps(platform))).toEqual(outcome('alive'));
  });
  it.each(['stat', 'status', 'cmdline'])('oversized %s fails closed; operator can retry or inspect manually', (file) => {
    const deps = singleDeps();
    replaceRead(deps, `/${file}`, () => 'x'.repeat(1024 * 1024 + 1));
    expect(probe(linuxIdentity, deps)).toEqual(outcome('unknown'));
  });
  it('oversized task enumeration stays unknown', () => {
    const deps = singleDeps('linux', { processes: [{ pid: PID, state: 'Z' }] });
    deps.readdir = () => Array(65537).fill(String(PID));
    expect(probe(linuxIdentity, deps)).toEqual(outcome('unknown'));
  });
});

describe('record canonical identities', () => {
  it.each(['linux', 'darwin'])('%s records canonical key and uid, without state', (platform) => {
    const { state, ...expected } = expectedFor(platform);
    expect(record(PID, singleDeps(platform, { bootId: BOOT.toUpperCase() }))).toEqual({ ok: true, identity: expected });
  });
  it.each([0, -1, 1.5, '123', NaN, Infinity, null])('refuses invalid pid %s', (pid) => {
    expect(record(pid, singleDeps())).toEqual({ ok: false, reason: 'invalid-pid' });
  });
  it.each(['pid2', 'ppid2', 'empty-cmdline-no-exe'])('kernel thread %s is never recordable or alive', (kind) => {
    const pid = kind === 'pid2' ? 2 : PID;
    const deps = singleDeps('linux', { processes: [{ pid, ppid: kind === 'ppid2' ? 2 : 1 }] });
    if (kind === 'empty-cmdline-no-exe') {
      replaceRead(deps, '/cmdline', () => '');
      const link = deps.readlink;
      deps.readlink = (path) => { if (path.endsWith('/exe')) throw enoent(); return link(path); };
    }
    expect(record(pid, deps)).toEqual({ ok: false, reason: 'kernel-thread' });
    expect(probe({ ...linuxIdentity, pid }, deps)).toEqual(outcome('unknown', 'kernel-thread'));
  });
  it('empty cmdline with an executable is a userspace process', () => {
    const deps = singleDeps();
    replaceRead(deps, '/cmdline', () => '');
    expect(probe(linuxIdentity, deps)).toEqual(outcome('alive'));
  });
  it('unreadable record is null-free', () => {
    const deps = singleDeps();
    replaceRead(deps, '/stat', denied);
    expect(record(PID, deps)).toEqual({ ok: false, reason: expect.any(String) });
  });
});

describe('evidence removal is monotone (exhaustive subsets)', () => {
  const sources = ['stat', 'status', 'task', 'bootId', 'ns', 'kill', 'ps'];
  function without(deps, removed) {
    const read = deps.readFile, exec = deps.exec, link = deps.readlink, dir = deps.readdir;
    return { ...deps,
      readFile: (path) => {
        if ((removed.has('stat') && path.endsWith('/stat')) ||
            (removed.has('status') && path.endsWith('/status')) ||
            (removed.has('bootId') && path.endsWith('/boot_id'))) return denied();
        return read(path);
      },
      exec: (file, ...args) => {
        if (removed.has(file === '/bin/ps' ? 'ps' : 'bootId')) return denied();
        return exec(file, ...args);
      },
      readlink: (path) => removed.has('ns') ? denied() : link(path),
      readdir: (path) => removed.has('task') ? denied() : dir(path),
      kill: (...args) => removed.has('kill') ? denied() : deps.kill(...args),
    };
  }
  it.each(['linux', 'darwin'])('%s every subset can only preserve or degrade evidence', (platform) => {
    // Include both absence and zombie death: losing stat must not manufacture absence.
    for (const fixture of ['alive', 'reused', 'gone', 'zombie']) {
      const options = fixture === 'gone' ? platform === 'linux' ? { processes: [] } : { output: '' }
        : fixture === 'zombie' ? platform === 'linux' ? { processes: [{ pid: PID, state: 'Z' }] } : { output: HEADER + psRow({ state: 'Z' }) }
        : fixture === 'reused' ? { bootId: OTHER_BOOT } : {};
      const deps = singleDeps(platform, options);
      const full = probe(expectedFor(platform), deps).state;
      expect(full).toBe(fixture === 'alive' ? 'alive' : 'dead');
      const states = Array.from({ length: 1 << sources.length }, (_, mask) => {
        const removed = new Set(sources.filter((_, bit) => mask & (1 << bit)));
        return probe(expectedFor(platform), without(deps, removed)).state;
      });
      for (let mask = 1; mask < states.length; mask++) {
        expect([full, 'unknown'], `${platform}/${fixture}/${mask}`).toContain(states[mask]);
      }
      for (let mask = 0; mask < states.length; mask++) {
        if (states[mask] !== 'unknown') continue;
        for (let subset = 0; subset < states.length; subset++) {
          if ((subset & mask) === mask) expect(states[subset], `${platform}/${fixture}/${mask}->${subset}`).toBe('unknown');
        }
      }
    }
  });
});
