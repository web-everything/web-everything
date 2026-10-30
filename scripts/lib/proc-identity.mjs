import { execFileSync } from 'node:child_process';
import { openSync, readSync, closeSync, opendirSync, readlinkSync } from 'node:fs';

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
  return { platform: process.platform, readFile, readdir, readlink: readlinkSync, kill: process.kill, exec: execFileSync, ...deps };
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

function linuxStat(pid, io, withParent = false) {
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
  if (withParent && (!/^\d+$/.test(fields[1]) || !unsigned(Number(fields[1])))) {
    throw new Error('Invalid parent pid');
  }
  return { pid, pgid, startTime: fields[19], state: fields[0],
    ...(withParent ? { ppid: Number(fields[1]) } : {}) };
}

function linuxUid(pid, io) {
  const status = boundedText(io.readFile(`/proc/${pid}/status`));
  const uidField = /^Uid:[\t ]+(\d+)(?:[\t ]|$)/m.exec(status);
  const uid = uidField ? Number(uidField[1]) : NaN;
  if (!unsigned(uid)) throw new Error('Missing real uid');
  return uid;
}

function linuxProcess(pid, io) {
  const before = linuxStat(pid, io);
  const uid = linuxUid(pid, io);
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
    a.bootId.toLowerCase() === b.bootId.toLowerCase() &&
    ['pid', 'startTime', 'uid'].every((key) => a[key] === b[key]));
}

export function liveness(expected, deps = {}) {
  if (!validIdentity(expected)) return 'unknown';
  const result = readIdentity(expected.pid, deps);
  if (result.status === 'gone') return 'dead';
  if (result.status !== 'ok') return 'unknown';
  return ['Z', 'X', 'x'].includes(result.identity.state) || !sameIdentity(expected, result.identity) ? 'dead' : 'alive';
}

function linuxCensusMount(io) {
  const mounts = boundedText(io.readFile('/proc/self/mountinfo')).trim().split('\n').map((line) => {
    const parts = line.split(' - ');
    const fields = parts[0].split(' ');
    const filesystem = parts[1]?.split(' ');
    if (parts.length !== 2 || fields.length < 6 || !fields.every(Boolean) ||
        filesystem.length !== 3 || !filesystem.every(Boolean)) {
      throw new Error('Malformed mount evidence; retry or inspect mount configuration manually');
    }
    return { line, fields, filesystem };
  });
  const procMounts = mounts.filter(({ fields }) => fields[4] === '/proc');
  if (procMounts.length !== 1) throw new Error('Procfs mount visibility unproven; inspect mount configuration manually');
  const { line, fields, filesystem } = procMounts[0];
  const options = [...fields[5].split(','), ...filesystem[2].split(',')];
  if (fields[3] !== '/' || filesystem[0] !== 'proc' ||
      options.some((option) => option.split('=')[0] === 'hidepid' && option !== 'hidepid=0')) {
    throw new Error('Procfs census may hide members; inspect mount configuration manually');
  }
  return line;
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
      // A visible leader cannot certify that hidepid exposes other users' members.
      const censusMount = linuxCensusMount(io);
      const names = io.readdir('/proc');
      if (!Array.isArray(names) || names.length > MAX_ENTRIES) throw new Error('procfs entry limit');
      // hidepid can omit the leader entirely, bypassing the per-entry checks.
      // Only confirmed absence permits a census without its PID directory.
      if (!names.includes(String(pgid)) && !linuxAbsenceConfirmed(pgid, io)) {
        throw new Error('Group leader missing from procfs census; absence unconfirmed');
      }
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
      if (linuxCensusMount(io) !== censusMount) throw new Error('Procfs mount changed during census; retry or inspect manually');
    } else return unknown('Unsupported platform');
    return { status: 'ok', identities: rows.filter((row) => row.pgid === pgid).map((row) => identity(row, bootId)) };
  } catch {
    return unknown('Group evidence unreadable, malformed or over limit; retry or inspect manually');
  }
}


const triState = (state, reason) => ({ state, reason });
const exited = (state) => ['Z', 'X', 'x'].includes(state);
const validPidNs = (value) => typeof value === 'string' && /^pid:\[\d{1,20}\]$/.test(value);

// The single-pid API intentionally does not change legacy liveness/listGroup.
// Missing evidence always yields unknown; retry or inspect manually after a
// read/scan/exec limit. Only absence of the initial stat can establish "gone".
function singleProcess(pid, io, checkExit = false) {
  if (!['linux', 'darwin'].includes(io.platform)) return triState('unknown', 'unsupported-platform');
  const bootId = currentBootId(io)?.toLowerCase();
  if (!bootId) return triState('unknown', 'boot-id-unavailable');
  if (io.platform === 'darwin') {
    const result = readIdentity(pid, io);
    if (result.status === 'gone') return triState('dead', 'gone');
    if (result.status !== 'ok') return triState('unknown', 'evidence-unavailable');
    return { entry: { ...result.identity, bootId: result.identity.bootId.toLowerCase() } };
  }
  if (pid === 2) return triState('unknown', 'kernel-thread');
  let before;
  try { before = linuxStat(pid, io, true); } catch (error) {
    if ((error.code === 'ENOENT' || error.code === 'ESRCH') && linuxAbsenceConfirmed(pid, io)) {
      return triState('dead', 'gone');
    }
    throw error;
  }
  if (before.ppid === 2) return triState('unknown', 'kernel-thread');
  // Exited leaders lose their namespace link; only stat and the task census
  // can prove exit. Recording still requires a complete namespace identity.
  if (checkExit && exited(before.state)) return exitedTasks(pid, io);
  const uid = linuxUid(pid, io);
  const pidNs = boundedText(io.readlink(`/proc/${pid}/ns/pid`));
  if (!validPidNs(pidNs)) throw new Error('Malformed pid namespace');
  const cmdline = boundedText(io.readFile(`/proc/${pid}/cmdline`));
  // Exited userspace tasks also lose cmdline/exe. Their state and task census
  // distinguish them from live kernel threads; ppid=2/pid=2 was checked above.
  if (!cmdline && !exited(before.state)) {
    try {
      if (!boundedText(io.readlink(`/proc/${pid}/exe`))) throw new Error('Malformed exe link');
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ESRCH') return triState('unknown', 'kernel-thread');
      throw error;
    }
  }
  const after = linuxStat(pid, io, true);
  if (before.startTime !== after.startTime || before.ppid !== after.ppid) {
    return triState('unknown', 'identity-changed-during-read');
  }
  return { entry: { pid, startTime: after.startTime, bootId, pidNs, uid, state: after.state } };
}

/** Capture a canonical identity. UID is retained as a filter, never as a key. */
export function record(pid, deps = {}) {
  try {
    if (!positive(pid)) return { ok: false, reason: 'invalid-pid' };
    const result = singleProcess(pid, dependencies(deps));
    if (!result.entry) return { ok: false, reason: result.reason };
    const identity = { ...result.entry };
    delete identity.state;
    return { ok: true, identity };
  } catch {
    return { ok: false, reason: 'evidence-unavailable' };
  }
}

function exitedTasks(pid, io) {
  let names;
  try { names = io.readdir(`/proc/${pid}/task`); } catch (error) {
    // A hidepid remount can conceal live workers after the leader stat was read.
    // A missing directory proves exit only with independent process absence.
    if ((error.code === 'ENOENT' || error.code === 'ESRCH') && linuxAbsenceConfirmed(pid, io)) {
      return triState('dead', 'exited');
    }
    throw error;
  }
  if (!Array.isArray(names) || !names.length || names.length > MAX_ENTRIES) {
    throw new Error('Incomplete task census; retry or inspect manually');
  }
  const taskIds = new Set(names);
  if (taskIds.size !== names.length) throw new Error('Duplicate task id');
  const deadline = Date.now() + TIMEOUT;
  for (const name of names) {
    if (Date.now() >= deadline) throw new Error('Task scan timed out; retry or inspect manually');
    if (typeof name !== 'string' || !/^[1-9]\d*$/.test(name) || !positive(Number(name))) {
      throw new Error('Malformed task id');
    }
    // A disappearing individual task is incomplete evidence, not proof that
    // every task has exited. linuxStat still validates the TID in field 1.
    const taskIo = { ...io, readFile: () => io.readFile(`/proc/${pid}/task/${name}/stat`) };
    if (!exited(linuxStat(Number(name), taskIo).state)) {
      return triState('unknown', 'zombie-leader-live-tasks');
    }
  }
  // A worker can create a successor and then exit after the initial census.
  // All sampled tasks being Z/X is only exit evidence if membership is stable
  // after those reads. Fail closed on changes or an unavailable final census.
  const finalNames = io.readdir(`/proc/${pid}/task`);
  if (!Array.isArray(finalNames) || finalNames.length !== taskIds.size ||
      new Set(finalNames).size !== taskIds.size || finalNames.some((name) => !taskIds.has(name)) ||
      Date.now() >= deadline) {
    throw new Error('Task census changed or incomplete; retry or inspect manually');
  }
  return triState('dead', 'exited');
}

/** Positive identity/exit evidence only. This API never throws. */
export function probe(expected, deps = {}) {
  try {
    if (!validIdentity(expected) || (expected.pidNs !== undefined && !validPidNs(expected.pidNs))) {
      return triState('unknown', 'invalid-expected');
    }
    const io = dependencies(deps);
    if (!['linux', 'darwin'].includes(io.platform)) return triState('unknown', 'unsupported-platform');
    if (!(io.platform === 'linux' ? validLinuxStart(expected.startTime) : validPsStart(expected.startTime))) {
      return triState('unknown', 'invalid-expected');
    }
    const result = singleProcess(expected.pid, io, true);
    if (!result.entry) return result;
    const observed = result.entry;
    if (observed.startTime !== expected.startTime || observed.bootId !== expected.bootId.toLowerCase() ||
        (expected.pidNs !== undefined && observed.pidNs !== undefined && expected.pidNs !== observed.pidNs)) {
      return triState('dead', 'pid-reused');
    }
    if (exited(observed.state)) {
      return io.platform === 'linux' ? exitedTasks(expected.pid, io) : triState('dead', 'exited');
    }
    return triState('alive', 'identity-match');
  } catch {
    return triState('unknown', 'evidence-unavailable');
  }
}
