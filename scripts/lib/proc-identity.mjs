import { execFileSync } from 'node:child_process';
import { openSync, readSync, closeSync, opendirSync } from 'node:fs';

const MAX_BYTES = 1024 * 1024;
const MAX_ENTRIES = 65536;
const TIMEOUT = 2000;
const EXEC_OPTIONS = Object.freeze({ encoding: 'utf8', timeout: TIMEOUT, maxBuffer: MAX_BYTES, shell: false, killSignal: 'SIGKILL' });
const BOOT_ID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const LINUX_START = /^(?:0|[1-9]\d{0,19})$/;
const PS_START = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ([1-9]|[12]\d|3[01]) ([01]\d|2[0-3]):[0-5]\d:[0-5]\d (\d{4})$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const unknown = (reason) => ({ status: 'unknown', reason });
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const unsigned = (value) => Number.isSafeInteger(value) && value >= 0;

function validBootId(value) {
  return typeof value === 'string' && value.length === 36 && BOOT_ID.test(value);
}

function validPsStart(value) {
  if (typeof value !== 'string' || value !== value.trim()) return false;
  const match = PS_START.exec(value);
  if (!match) return false;
  const [, month, day, , year] = match;
  const date = new Date(0);
  date.setUTCFullYear(Number(year), MONTHS.indexOf(month), Number(day));
  return date.getUTCMonth() === MONTHS.indexOf(month) && date.getUTCDate() === Number(day);
}

function validLinuxStart(value) {
  return typeof value === 'string' && value === value.trim() && LINUX_START.test(value);
}

function boundedText(value) {
  if (!(typeof value === 'string' || Buffer.isBuffer(value))) throw new Error('Non-text evidence');
  if (Buffer.byteLength(value) > MAX_BYTES) throw new Error('Evidence exceeds 1 MiB; retry or inspect manually');
  return value.toString();
}

// procfs reports zero file sizes, so enforce the limit while reading, not with stat.
function readFile(path, fs = { openSync, readSync, closeSync }) {
  const fd = fs.openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    const deadline = Date.now() + TIMEOUT;
    while (length < buffer.length) {
      if (Date.now() >= deadline) throw new Error('procfs read timed out; retry or inspect manually');
      const count = fs.readSync(fd, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    return boundedText(buffer.subarray(0, length));
  } finally {
    fs.closeSync(fd);
  }
}

function readdir(path, fs = { opendirSync }) {
  const dir = fs.opendirSync(path);
  try {
    const entries = [];
    const deadline = Date.now() + TIMEOUT;
    for (let entry; (entry = dir.readSync());) {
      if (entries.length >= MAX_ENTRIES || Date.now() >= deadline) {
        throw new Error('procfs scan limit reached; retry or inspect manually');
      }
      entries.push(entry.name);
    }
    return entries;
  } finally {
    dir.closeSync();
  }
}

function dependencies(deps) {
  return { platform: process.platform, readFile, readdir, kill: process.kill, exec: execFileSync, ...deps };
}

function exec(deps, file, args) {
  return boundedText(deps.exec(file, args, { ...EXEC_OPTIONS, env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' } }));
}

// Export the production adapters so their byte/read/closure bounds can be tested.
export { readFile as boundedReadFile, readdir as boundedReaddir };

/** A missing or unreadable boot identifier is never a wildcard identity. */
export function currentBootId(deps = {}) {
  const io = dependencies(deps);
  try {
    const value = (io.platform === 'linux'
      ? boundedText(io.readFile('/proc/sys/kernel/random/boot_id'))
      : io.platform === 'darwin' ? exec(io, '/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid']) : '').trim();
    return validBootId(value) ? value : null;
  } catch {
    return null;
  }
}

function linuxStat(pid, io) {
  const stat = boundedText(io.readFile(`/proc/${pid}/stat`)).trim();
  const end = stat.lastIndexOf(')');
  if (!stat.startsWith(`${pid} (`) || end < 0) throw new Error('Malformed procfs stat');
  const fields = stat.slice(end + 1).trim().split(/\s+/);
  if (fields.length < 20 || !/^[RSDZTtWXxKPI]$/.test(fields[0]) ||
      !/^\d+$/.test(fields[2]) || !validLinuxStart(fields[19])) {
    throw new Error('Incomplete procfs stat');
  }
  const pgid = Number(fields[2]);
  // Kernel threads may have pgrp=0; listGroup filters them out of positive groups.
  if (!unsigned(pgid)) throw new Error('Invalid process group');
  return { pid, pgid, startTime: fields[19], state: fields[0] };
}

function linuxProcess(pid, io) {
  const before = linuxStat(pid, io);
  const status = boundedText(io.readFile(`/proc/${pid}/status`));
  const uidField = /^Uid:[\t ]+(\d+)(?:[\t ]|$)/m.exec(status);
  const uid = uidField ? Number(uidField[1]) : NaN;
  if (!unsigned(uid)) throw new Error('Missing real uid');
  // Bracket the UID read so a reused PID cannot combine two process identities.
  // The final state also observes a process that exited during the status read.
  const after = linuxStat(pid, io);
  if (before.startTime !== after.startTime) throw new Error('Process changed during identity probe');
  return { ...after, uid };
}

function psProcesses(output) {
  const rows = output.trim() ? output.trim().split('\n') : [];
  if (rows.length > MAX_ENTRIES) throw new Error('ps row limit reached; inspect manually');
  if (rows.length && /^\s*RUID\s+PID\s+PPID\s+PGID\s+STAT\s+STARTED\s*$/.test(rows[0])) rows.shift();
  return rows.map((row) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+([A-Za-z]\S*)\s+(.+?)\s*$/.exec(row);
    if (!match) throw new Error('Malformed ps row');
    const [, uid, pid, ppid, pgid, state, start] = match;
    const startTime = start.trim().replace(/\s+/g, ' ');
    if (!unsigned(Number(uid)) || !positive(Number(pid)) || !unsigned(Number(ppid)) || !positive(Number(pgid)) ||
        !/^[IRSTUZ][+<>AELNSsVWX]*$/.test(state) || !validPsStart(startTime)) {
      throw new Error('Incomplete ps identity');
    }
    return { pid: Number(pid), pgid: Number(pgid), uid: Number(uid), startTime, state: state[0] };
  });
}

function identity({ pgid, ...entry }, bootId) {
  return { ...entry, bootId };
}

function linuxAbsenceConfirmed(pid, io) {
  if (!currentBootId(io)) return false;
  // hidepid can conceal a live process even while boot_id is readable.
  // Signal 0 checks existence without delivering a signal; EPERM is unknown.
  try { io.kill(pid, 0); } catch (error) {
    return error.code === 'ESRCH';
  }
  return false;
}

export function readIdentity(pid, deps = {}) {
  if (!positive(pid)) return unknown('Invalid pid');
  const io = dependencies(deps);
  let entry;
  try {
    if (io.platform === 'linux') {
      try { entry = linuxProcess(pid, io); } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ESRCH') {
          return linuxAbsenceConfirmed(pid, io) ? { status: 'gone' } : unknown('Process absence unconfirmed');
        }
        throw error;
      }
    } else if (io.platform === 'darwin') {
      let output;
      try {
        output = exec(io, '/bin/ps', ['-o', 'ruid,pid,ppid,pgid,stat,lstart', '-p', String(pid)]);
      } catch (error) {
        // Darwin ps exits 1 on no match. Only its empty/header-only, bounded
        // output without execution errors is absence evidence, never a census.
        if (error.status !== 1 || error.code || error.signal ||
            (error.stderr != null && boundedText(error.stderr).trim())) throw error;
        output = boundedText(error.stdout);
        if (psProcesses(output).length) throw error;
      }
      const rows = psProcesses(output);
      if (!rows.length) return { status: 'gone' };
      if (rows.length !== 1 || rows[0].pid !== pid) return unknown('Unexpected ps identity');
      entry = rows[0];
    } else return unknown('Unsupported platform');
    const bootId = currentBootId(io);
    return bootId ? { status: 'ok', identity: identity(entry, bootId) } : unknown('Boot identity unavailable');
  } catch {
    return unknown('Process evidence unreadable, malformed or over limit; retry or inspect manually');
  }
}

function validIdentity(value) {
  return value && positive(value.pid) && unsigned(value.uid) &&
    (validLinuxStart(value.startTime) || validPsStart(value.startTime)) && validBootId(value.bootId);
}

export function sameIdentity(a, b) {
  return Boolean(validIdentity(a) && validIdentity(b) &&
    ['pid', 'startTime', 'bootId', 'uid'].every((key) => a[key] === b[key]));
}

export function liveness(expected, deps = {}) {
  if (!validIdentity(expected)) return 'unknown';
  const result = readIdentity(expected.pid, deps);
  if (result.status === 'gone') return 'dead';
  if (result.status !== 'ok') return 'unknown';
  return ['Z', 'X', 'x'].includes(result.identity.state) || !sameIdentity(expected, result.identity) ? 'dead' : 'alive';
}

/** Incomplete enumeration yields unknown, never a partial membership snapshot. */
export function listGroup(pgid, deps = {}) {
  if (!positive(pgid)) return unknown('Invalid process group');
  const io = dependencies(deps);
  try {
    const bootId = currentBootId(io);
    if (!bootId) return unknown('Boot identity unavailable');
    let rows;
    if (io.platform === 'darwin') {
      rows = psProcesses(exec(io, '/bin/ps', ['-A', '-o', 'ruid,pid,ppid,pgid,stat,lstart']));
      // An all-process census must include at least ps itself. Empty output is
      // incomplete evidence, unlike an empty per-PID query in readIdentity.
      if (!rows.length) throw new Error('Empty all-process census');
    } else if (io.platform === 'linux') {
      const names = io.readdir('/proc');
      if (!Array.isArray(names) || names.length > MAX_ENTRIES) throw new Error('procfs entry limit');
      rows = [];
      const deadline = Date.now() + TIMEOUT;
      for (const name of names) {
        if (Date.now() >= deadline) throw new Error('procfs scan timeout');
        if (typeof name !== 'string') throw new Error('Invalid procfs entry');
        if (!/^\d+$/.test(name)) continue;
        const pid = Number(name);
        if (!positive(pid)) throw new Error('Invalid procfs pid');
        try { rows.push(linuxProcess(pid, io)); } catch (error) {
          if ((error.code !== 'ENOENT' && error.code !== 'ESRCH') || !linuxAbsenceConfirmed(pid, io)) throw error;
        }
      }
    } else return unknown('Unsupported platform');
    return { status: 'ok', identities: rows.filter((row) => row.pgid === pgid).map((row) => identity(row, bootId)) };
  } catch {
    return unknown('Group evidence unreadable, malformed or over limit; retry or inspect manually');
  }
}
