import { describe, it, expect, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { readIdentity, sameIdentity, liveness, currentBootId, listGroup } from '../proc-identity.mjs';

const PID = 12345;
const UID = 501;
const BOOT = '8b61301a-27f4-4828-9ce1-9fc23bf14377';
const OTHER_BOOT = '7b61301a-27f4-4828-9ce1-9fc23bf14377';
const START = 'Tue Oct 28 13:30:00 2026';
const HEADER = '  UID   PID  PPID  PGID STAT                  STARTED\n';
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
      if (file === 'sysctl' && JSON.stringify(args) === JSON.stringify(['-n', 'kern.bootsessionuuid'])) {
        return ` ${bootId}\n`;
      }
      if (file === 'ps') return output;
      throw new Error(`Unexpected executable: ${file}`);
    }),
  };
}

const linuxIdentity = { pid: PID, startTime: '987654', bootId: BOOT, uid: UID, state: 'S' };
const darwinIdentity = { ...linuxIdentity, startTime: START };

describe('readIdentity parsers', () => {
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
});

describe('sameIdentity', () => {
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
    expect(deps.exec).toHaveBeenCalledWith('ps', ['-o', 'uid,pid,ppid,pgid,stat,lstart', '-p', String(PID)], expect.any(Object));
    expect(deps.exec).toHaveBeenCalledWith('ps', ['-A', '-o', 'uid,pid,ppid,pgid,stat,lstart'], expect.any(Object));
    expect(deps.exec).toHaveBeenCalledWith('sysctl', ['-n', 'kern.bootsessionuuid'], expect.any(Object));
    deps.exec.mock.calls.forEach(([file, args, options]) => {
      expect(['ps', 'sysctl']).toContain(file);
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
  it('an unreadable Linux member invalidates the whole group snapshot', () => {
    const deps = linuxDeps({ processes: [{ pid: PID }, { pid: PID + 1 }] });
    const readFile = deps.readFile;
    deps.readFile = (path) => {
      if (path === `/proc/${PID + 1}/status`) throw new Error('denied');
      return readFile(path);
    };
    expect(listGroup(PID, deps)).toEqual({ status: 'unknown', reason: expect.any(String) });
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
      if (file === 'ps') throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
      return exec(file, ...args);
    });
    expect(listGroup(PID, deps)).toEqual({ status: 'unknown', reason: expect.any(String) });
    expect(deps.exec).toHaveBeenCalledWith('ps', ['-A', '-o', 'uid,pid,ppid,pgid,stat,lstart'], expect.any(Object));
  });
});

describe('real host process identity', () => {
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
      const deadline = Date.now() + 6000;
      const waitForZombie = async () => {
        const result = readIdentity(pid);
        if (result.status === 'ok' && result.identity.state === 'Z') return result.identity;
        if (Date.now() >= deadline) throw new Error(`Zombie state not observed within 6s: ${JSON.stringify(result)}`);
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
  }, 12000);
});
