/**
 * @file Resumable detached commands with atomic lifecycle records and bounded foreground waits.
 * Ownership v2: runner + guarded command group + marker/log writers + remembered identities.
 * Only the runner writes while alive; an O_EXCL reaper takes over after proven runner death.
 * Probes are asynchronous, bounded and three-valued. Unknown is never proof of life or death.
 * Containment is best effort: cgroups are deferred. A descendant that removes its marker,
 * closes both logs and reparents before observation is unobservable; this is not a security
 * boundary. Incomplete scans or surviving known owners report escaped-descendants, never done.
 * Linux permission barriers in unobserved processes born before the runner do not imply
 * escaped descendants. Observed owners remain eligible regardless of their birth time.
 * CLI: --detach | --wait-for=<id> | --cancel=<id>, with --max-wait-ms=<250..540000>.
 * Wait/cancel return 0 for success, 1 for terminal failure, 75 while pending (including
 * unknown identity or reaper cleanup). Terminal records describe observed owners only.
 * A killed reaper is not replaced by TTL: wait stays pending rather than racing two writers.
 */
import { execFile, spawn } from 'node:child_process';
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeLineSync } from './write-all-sync.mjs';

const SELF = fileURLToPath(import.meta.url);
const MAX_PROCESSES = 32768;
const PROBE_MS = 1000;
const SCAN_MS = 2500;
const STOP_MS = 8000;

// Also bounds injected/unresponsive probes. Clearing the timer avoids keeping short waits alive.
async function bounded(work, ms, fallback = null, parentSignal) {
  if (ms <= 0 || parentSignal?.aborted) return fallback;
  const controller = new AbortController();
  let timer, expire;
  try {
    return await Promise.race([Promise.resolve().then(() => work(controller.signal)).catch(() => fallback),
      new Promise(done => {
        expire = () => { controller.abort(); done(fallback); };
        timer = setTimeout(expire, ms);
        parentSignal?.addEventListener('abort', expire, { once: true });
      })]);
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', expire);
    controller.abort();
  }
}
function observerEnv() {
  const env = { ...process.env, LC_ALL: 'C', TZ: 'UTC' };
  delete env.WE_DETACHED_OP;
  return env;
}
function command(file, args, { deadline = Date.now() + PROBE_MS, emptyExit = false, signal } = {}) {
  return new Promise((done, reject) => {
    execFile(file, args, { encoding: 'utf8', timeout: Math.max(1, deadline - Date.now()),
      killSignal: 'SIGKILL', signal, maxBuffer: 8 * 1024 * 1024, env: observerEnv() }, (error, stdout, stderr) => {
      if (error && !(emptyExit && error.code === 1 && !error.signal && !stderr.trim())) reject(error);
      else if (stderr.trim()) reject(new Error('incomplete process probe'));
      else done(stdout);
    });
  });
}
function macRows(output, scope) {
  return output.trim().split('\n').filter(Boolean).map(line => {
    const row = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})(?:\s+(.*))?$/.exec(line);
    if (!row) throw new Error('invalid ps row');
    return { uid: Number(row[1]), pid: Number(row[2]), ppid: Number(row[3]), pgid: Number(row[4]),
      state: row[5], start: row[6].replace(/\s+/g, ' '), argv: row[7] || '', platform: 'darwin', scope };
  });
}
function identity(row) {
  if (!row || row.state?.startsWith('Z')) return null;
  return { pid: row.pid, platform: row.platform, start: row.start, scope: row.scope,
    ...(row.bootId ? { bootId: row.bootId } : {}) };
}
export function sameProcess(a, b) {
  return Boolean(a && b && typeof a.start === 'string' && a.start && typeof a.scope === 'string'
    && a.pid === b.pid && a.platform === b.platform && a.start === b.start
    && a.scope === b.scope && a.bootId === b.bootId);
}
function identityKey(p) { return `${p.pid}\0${p.platform}\0${p.start}\0${p.bootId || ''}\0${p.scope}`; }
function predatesRunner(row, record) {
  const runner = record.runnerIdentity;
  return row && runner?.platform === 'linux' && runner.pid === record.pid
    && runner.scope === row.scope && runner.bootId === row.bootId
    && typeof runner.start === 'string' && /^[0-9]+$/.test(runner.start)
    && BigInt(row.start) < BigInt(runner.start);
}
async function linuxRow(pid, scope, io, bootId, signal) {
  const raw = await io.readFile(`/proc/${pid}/stat`, { encoding: 'utf8', signal });
  const end = raw.lastIndexOf(')');
  if (end < 0) throw new Error('invalid proc stat');
  const fields = raw.slice(end + 2).trim().split(/\s+/);
  if (!/^\d+$/.test(fields[19]) || !bootId?.trim()) throw new Error('incomplete proc identity');
  return { pid, ppid: Number(fields[1]), pgid: Number(fields[2]), state: fields[0],
    start: fields[19], platform: 'linux', bootId: bootId.trim(), scope };
}
/** Read a birth identity without blocking the event loop. Missing and unreadable are distinct. */
export async function readProcess(pid, { scope, deadline = Date.now() + PROBE_MS,
  platform = process.platform, io = fs, exec = command, signal: parentSignal } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return { alive: false };
  return bounded(async signal => {
    try {
      let row;
      if (platform === 'linux') {
        const bootId = await io.readFile('/proc/sys/kernel/random/boot_id', { encoding: 'utf8', signal }).catch(() => null);
        if (!bootId) return { alive: null };
        try { row = await linuxRow(pid, scope, io, bootId, signal); }
        catch (error) { return { alive: ['ENOENT', 'ESRCH'].includes(error.code) ? false : null }; }
      } else if (platform === 'darwin') {
        const output = await exec('/bin/ps', ['-ww', '-p', String(pid), '-o', 'uid=,pid=,ppid=,pgid=,stat=,lstart=,command='],
          { deadline, emptyExit: true, signal });
        row = macRows(output, scope)[0];
      } else return { alive: null };
      return row && !row.state.startsWith('Z') ? { alive: true, identity: identity(row), row } : { alive: false };
    } catch { return { alive: null }; }
  }, deadline - Date.now(), { alive: null }, parentSignal);
}
export async function probeRunner(pid, record, { deadline = Date.now() + PROBE_MS, read = readProcess, signal } = {}) {
  const current = await read(pid, { scope: record.recordPath, deadline, signal });
  if (current.alive !== true) return current.alive;
  if (record.runnerIdentity) {
    if (!sameProcess(record.runnerIdentity, current.identity)) return false;
    // lstart has second precision on macOS; bind the runner to this record as well.
    if (current.row?.platform === 'darwin'
      && !current.row.argv.includes(`--run-record=${record.recordPath}`)) return false;
    return true;
  }
  // Legacy records can prove death from a mismatch, but missing stamps cannot prove life.
  if (record.runnerStart && current.row?.platform === 'darwin') {
    if (record.runnerStart.trim().replace(/\s+/g, ' ') !== current.identity.start) return false;
    return record.runnerArgv ? current.row.argv.includes(record.runnerArgv) : null;
  }
  return null;
}

/** Snapshot all observable owners. Never infer ownership from a numeric pgid alone. */
export async function collectOwnedProcesses(record, { deadline = Date.now() + SCAN_MS,
  platform = process.platform, io = fs, exec = command, uid = process.getuid?.() } = {}) {
  const incomplete = { members: [], complete: false };
  return bounded(async signal => {
    let rows = [], complete = true;
    const marked = new Set(), logged = new Set();
    const scope = record.recordPath;
    const known = [record.commandIdentity, ...(record.members || [])].filter(Boolean);
    if (platform === 'linux') {
      const bootId = await io.readFile('/proc/sys/kernel/random/boot_id', { encoding: 'utf8', signal });
      const names = (await io.readdir('/proc')).filter(n => /^\d+$/.test(n));
      if (names.length > MAX_PROCESSES) return incomplete;
      const logs = await Promise.all([record.stdoutPath, record.stderrPath].map(path => io.stat(path)));
      // Small batches bound descriptors and outstanding filesystem work.
      for (let i = 0; i < names.length; i += 16) {
        if (Date.now() >= deadline) return { members: [], complete: false };
        await Promise.all(names.slice(i, i + 16).map(async name => {
          const pid = Number(name);
          if (pid === record.pid || pid === process.pid) return;
          let row, processComplete = true, permissionOnly = true, logInodeObserved = false;
          const markIncomplete = error => {
            processComplete = false;
            permissionOnly &&= ['EACCES', 'EPERM'].includes(error?.code);
          };
          try {
            if ((await io.stat(`/proc/${pid}`)).uid !== uid) return;
            row = await linuxRow(pid, scope, io, bootId, signal);
            if (row.state.startsWith('Z')) return;
            try {
              const env = await io.readFile(`/proc/${pid}/environ`, { encoding: 'utf8', signal });
              if (env.split('\0').includes(`WE_DETACHED_OP=${record.id}`)) marked.add(pid);
            } catch (error) {
              if (['ENOENT', 'ESRCH'].includes(error.code)) return;
              markIncomplete(error);
            }
            // Marker and log probes are independent: denied environ access must not
            // hide a writable log holder, including one older than the runner.
            const fds = await io.readdir(`/proc/${pid}/fd`);
            if (fds.length > 4096) markIncomplete();
            for (const fd of fds.length > 4096 ? [] : fds) {
              try {
                const info = await io.stat(`/proc/${pid}/fd/${fd}`);
                if (logs.some(log => log.dev === info.dev && log.ino === info.ino)) {
                  logInodeObserved = true;
                  const fdinfo = await io.readFile(`/proc/${pid}/fdinfo/${fd}`, { encoding: 'utf8', signal });
                  const flags = /^flags:\s+([0-7]+)$/m.exec(fdinfo);
                  if (!flags) markIncomplete();
                  // Log readers (including --wait-for itself) do not own operation work.
                  else if ((Number.parseInt(flags[1], 8) & 3) !== 0) logged.add(pid);
                }
              } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) markIncomplete(error); }
            }
          } catch (error) {
            if (['ENOENT', 'ESRCH'].includes(error.code)) return;
            markIncomplete(error);
          }
          if (!processComplete) {
            // Exiting processes can lose proc permissions before their directory disappears.
            // Recheck birth identity before classifying a live owner or an unrelated older process.
            try {
              const current = await linuxRow(pid, scope, io, bootId, signal);
              if (current.state.startsWith('Z') || (row && !sameProcess(identity(row), identity(current)))) return;
              // A process older than this runner cannot be its descendant. Do not
              // let an unrelated host service's ptrace restrictions poison every job.
              // Positive ownership, missing birth evidence and other scan errors still fail closed.
              if (permissionOnly && predatesRunner(row, record) && !marked.has(pid) && !logInodeObserved
                && !known.some(member => sameProcess(member, identity(row)))) return;
            } catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) return; }
            complete = false;
          }
          if (row) rows.push(row);
        }));
      }
    } else if (platform === 'darwin') {
      rows = macRows(await exec('/bin/ps', ['-ax', '-o', 'uid=,pid=,ppid=,pgid=,stat=,lstart='], { deadline, signal }), scope)
        .filter(row => row.uid === uid && !row.state.startsWith('Z'));
      if (rows.length > MAX_PROCESSES) return incomplete;
      const probes = await Promise.allSettled([
        exec('/bin/ps', ['eww', '-ax', '-o', 'pid=,command='], { deadline, signal }),
        exec('/usr/sbin/lsof', ['-nP', '-Fpfa', '--', record.stdoutPath, record.stderrPath], { deadline, emptyExit: true, signal }),
      ]);
      if (probes[0].status === 'fulfilled') {
        const marker = new RegExp(`(?:^|\\s)WE_DETACHED_OP=${record.id}(?=\\s|$)`);
        for (const line of probes[0].value.split('\n')) {
          const match = /^\s*(\d+)\s+(.*)$/.exec(line);
          if (match && marker.test(match[2])) marked.add(Number(match[1]));
        }
      } else complete = false;
      if (probes[1].status === 'fulfilled') {
        let pid, fd, access;
        const flush = () => {
          if (!pid || fd === undefined) return;
          if (access === 'w' || access === 'u') logged.add(pid);
          else if (access !== 'r') complete = false;
        };
        for (const line of probes[1].value.split('\n')) {
          if (/^p\d+$/.test(line)) { flush(); pid = Number(line.slice(1)); fd = undefined; access = undefined; }
          else if (line.startsWith('f')) { flush(); fd = line.slice(1); access = undefined; }
          else if (line.startsWith('a')) access = line.slice(1);
        }
        flush();
      } else complete = false;
    } else return incomplete;
    const knownKeys = new Set(known.map(identityKey));
    const leader = rows.find(row => row.pid === record.commandIdentity?.pid);
    // A reused group leader revokes group ownership, even if the integer pgid matches.
    const groupOwned = leader ? sameProcess(identity(leader), record.commandIdentity)
      : rows.some(row => row.pgid === record.commandIdentity?.pid && knownKeys.has(identityKey(row)));
    const eligible = rows.filter(row => row.pid !== record.pid && row.pid !== process.pid);
    const owned = new Set(eligible.filter(row => marked.has(row.pid) || logged.has(row.pid)
      || knownKeys.has(identityKey(row))
      || (groupOwned && row.pgid === record.commandIdentity?.pid)).map(row => row.pid));
    // Parentage alone is not ownership: a nested detached op has its own marker,
    // group and logs, and must survive completion of its launching operation.
    return { members: rows.filter(row => owned.has(row.pid) && row.pid !== record.pid && row.pid !== process.pid)
      .map(identity), complete };
  }, deadline - Date.now(), incomplete);
}

async function signalIdentity(expected, signal, { read = readProcess, kill = process.kill.bind(process),
  deadline = Date.now() + PROBE_MS } = {}) {
  if (!expected) return false;
  const current = await read(expected.pid, { scope: expected.scope, deadline });
  if (current.alive === false) return true;
  if (current.alive !== true || !sameProcess(expected, current.identity)) return current.alive === true;
  try { kill(expected.pid, signal); return true; }
  catch (error) { return error.code === 'ESRCH'; }
}
/** Individual identity checks also avoid the check/kill(-pgid) reuse hazard entirely. */
export async function sweepOwnedProcesses(record, { signal = 'SIGTERM', deadline = Date.now() + STOP_MS,
  collect = collectOwnedProcesses, read = readProcess, kill = process.kill.bind(process), pause = sleep } = {}) {
  let members = [record.commandIdentity, ...(record.members || [])].filter(Boolean), complete = false, emptyPasses = 0;
  const signalledAt = new Map();
  while (Date.now() < deadline) {
    const snapshot = await collect({ ...record, members }, { deadline: Math.min(deadline, Date.now() + SCAN_MS) });
    const combined = new Map([...members, ...snapshot.members].map(p => [identityKey(p), p]));
    members = [...combined.values()];
    const remaining = [];
    complete = snapshot.complete && !record.ownershipIncomplete;
    if (members.length > MAX_PROCESSES) return { complete: false, members: members.slice(0, MAX_PROCESSES), reason: 'escaped-descendants' };
    for (const member of members) {
      const current = await read(member.pid, { scope: member.scope, deadline });
      if (current.alive === false || (current.alive === true && !sameProcess(member, current.identity))) continue;
      remaining.push(member);
      if (current.alive !== true) { complete = false; continue; }
      const key = identityKey(member), firstSignal = signalledAt.get(key);
      const nextSignal = firstSignal === undefined || Date.now() < firstSignal + 200 ? signal : 'SIGKILL';
      if (!await signalIdentity(member, nextSignal, { read, kill, deadline })) complete = false;
      else if (firstSignal === undefined) signalledAt.set(key, Date.now());
    }
    members = remaining;
    if (complete && !members.length) {
      if (++emptyPasses === 2) return { complete: true, members: [] };
    } else emptyPasses = 0;
    await pause(Math.min(100, Math.max(0, deadline - Date.now())));
  }
  return { complete: false, members, reason: 'escaped-descendants' };
}

export const resolveDetachedOpsDir = (env = process.env) => env.DETACHED_OPS_DIR
  || join(homedir(), 'workspace', '.operations', 'coordination', 'detached-ops');
function budget(value = 540000) {
  const n = Number(value);
  if (!String(value).trim() || !Number.isFinite(n)) throw new RangeError('--max-wait-ms must be numeric');
  return Math.max(250, Math.min(n, 540000));
}
export function parseDetachFlags(args) {
  const flags = { detach: false, waitFor: null, maxWaitMs: 540000, rest: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') { flags.rest.push(...args.slice(i)); break; }
    if (arg === '--detach') flags.detach = true;
    else if (arg === '--cancel') flags.cancel = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : '';
    else if (arg.startsWith('--cancel=')) flags.cancel = arg.slice(9);
    else if (arg === '--wait-for') flags.waitFor = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : '';
    else if (arg.startsWith('--wait-for=')) flags.waitFor = arg.slice(11);
    else if (arg.startsWith('--max-wait-ms=')) flags.maxWaitMs = budget(arg.slice(14));
    else flags.rest.push(arg);
  }
  if (Number(flags.detach) + Number(flags.waitFor !== null) + Number(flags.cancel !== undefined) > 1) {
    throw new Error('--detach, --wait-for and --cancel are mutually exclusive');
  }
  return flags;
}
function recordPath(dir, id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) throw new Error('invalid job id');
  return join(dir, `${id}.json`);
}
function writeRecord(path, record) {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}
function tail(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const buffer = Buffer.alloc(Math.min(size, 65536));
    return buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, size - buffer.length)).toString('utf8');
  } catch { return ''; }
  finally { if (fd !== undefined) closeSync(fd); }
}
export async function startDetachedOp({ argv, kind, dir = resolveDetachedOpsDir(), env = process.env,
  spawnFn = spawn, now = Date.now, random = randomUUID, read = readProcess } = {}) {
  if (!Array.isArray(argv) || !argv.length) throw new Error('command required');
  dir = resolve(dir);
  mkdirSync(dir, { recursive: true });
  const id = `${now()}-${String(random()).replace(/[^A-Za-z0-9_-]/g, '')}`;
  const path = recordPath(dir, id);
  const record = { id, kind, version: 2, recordPath: path, containment: 'best-effort',
    status: 'running', pid: process.pid, startedAt: new Date(now()).toISOString(),
    exitCode: null, stdoutPath: join(dir, `${id}.stdout.log`), stderrPath: join(dir, `${id}.stderr.log`) };
  // Detached work outlives its launcher's admission slot and must acquire its own.
  // Scrub at the shared boundary so every detached entry point follows this rule.
  const childEnv = { ...env, WE_DETACHED_OP: id };
  delete childEnv.WE_HEAVY_ADMISSION_HELD;
  const fds = [];
  try {
    fds.push(openSync(record.stdoutPath, 'w', 0o600));
    fds.push(openSync(record.stderrPath, 'w', 0o600));
    writeRecord(path, record);
    const child = spawnFn(process.execPath, [SELF, `--run-record=${path}`, '--', ...argv],
      { detached: true, stdio: ['ignore', ...fds], env: childEnv });
    if (child.once) await new Promise((done, reject) => { child.once('spawn', done); child.once('error', reject); });
    record.pid = child.pid;
    // Birth stamp lets waiters tell the runner from a later process that reuses its pid.
    record.runnerIdentity = (await read(child.pid, { scope: path })).identity ?? null;
    writeRecord(path, record);
    child.unref();
    // Drop the launcher's writable log handles before releasing the execution barrier.
    for (const fd of fds.splice(0)) closeSync(fd);
    // The command waits for this reaper's O_EXCL readiness receipt. Even SIGKILL
    // immediately after returning the runner pid leaves an independent cleaner.
    const reaperEnv = { ...childEnv };
    delete reaperEnv.WE_DETACHED_OP;
    const reaper = spawnFn(process.execPath, [SELF, `--reap-record=${path}`],
      { detached: true, stdio: 'ignore', env: reaperEnv });
    if (reaper.once) await new Promise((done, reject) => { reaper.once('spawn', done); reaper.once('error', reject); });
    reaper.unref();
    return record;
  } finally { for (const fd of fds) closeSync(fd); }
}
export async function waitForOp({ id, maxWaitMs = 540000, dir = resolveDetachedOpsDir(),
  now = Date.now, sleep: pause = sleep, isAlive = probeRunner } = {}) {
  const deadline = now() + budget(maxWaitMs);
  const wallDeadline = Date.now() + budget(maxWaitMs);
  let deadRunnerObserved = false;
  let liveness = 'unknown';
  for (;;) {
    let record;
    try {
      record = JSON.parse(readFileSync(recordPath(dir, id), 'utf8'));
      if (record.id !== id || !['running', 'done', 'failed'].includes(record.status)
        || !Number.isInteger(record.pid) || record.pid <= 0
        || typeof record.stdoutPath !== 'string' || typeof record.stderrPath !== 'string'
        || ![record.runnerStart, record.runnerArgv].every(v => v === undefined || v === null || typeof v === 'string')
        || (record.version === 2 && record.recordPath !== resolve(recordPath(dir, id)))
        || (record.status === 'running' && record.exitCode !== null)
        || (record.status === 'done' && record.exitCode !== 0)
        || (record.status === 'failed' && (!Number.isInteger(record.exitCode) || record.exitCode <= 0))) {
        throw new Error('incomplete job record');
      }
    } catch (error) { return { id, status: 'failed', code: 1, reason: error.code === 'ENOENT' ? 'unknown-job' : 'invalid-record' }; }
    const result = { ...record, stdoutTail: tail(record.stdoutPath), stderrTail: tail(record.stderrPath) };
    if (record.status !== 'running') return { ...result, code: record.status === 'done' ? 0 : 1 };
    if (deadRunnerObserved && record.version !== 2) return { ...result, status: 'failed', code: 1, reason: 'runner-died' };
    const remaining = Math.min(deadline - now(), wallDeadline - Date.now());
    if (remaining <= 0) return { ...result, code: 75, liveness,
      ...(deadRunnerObserved ? { reason: 'cleanup-pending' } : {}) };
    const live = await bounded(signal => isAlive(record.pid, record,
      { deadline: Date.now() + Math.min(PROBE_MS, remaining), signal }), remaining);
    liveness = live === true ? 'alive' : live === false ? 'dead' : 'unknown';
    if (live === false && !deadRunnerObserved) {
      // The runner publishes its terminal record before exiting. Re-read and
      // validate it once before classifying a stale running snapshot as runner-died.
      deadRunnerObserved = true;
      continue;
    }
    const left = Math.min(deadline - now(), wallDeadline - Date.now());
    if (left <= 0) return { ...result, code: 75, liveness,
      ...(deadRunnerObserved ? { reason: 'cleanup-pending' } : {}) };
    await pause(Math.min(1000, left));
  }
}
/** Durable cancellation request: no caller ever signals an unverified saved pid. */
export async function cancelOp({ id, dir = resolveDetachedOpsDir(), ...options } = {}) {
  let record, path;
  try {
    path = recordPath(resolve(dir), id);
    record = JSON.parse(readFileSync(path, 'utf8'));
    if (record.id !== id || record.version !== 2 || record.recordPath !== path) {
      return { id, code: 1, status: 'failed', reason: 'unsupported-cancellation-record' };
    }
    if (record.status === 'running') {
      try { writeFileSync(`${path}.cancel`, 'SIGTERM\n', { flag: 'wx', mode: 0o600 }); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (!cancellationRequested(path)) throw new Error('missing cancellation request');
      }
    }
  } catch (error) { return { id, code: 1, status: 'failed', reason: error.code === 'ENOENT' ? 'unknown-job' : 'invalid-record' }; }
  return waitForOp({ ...options, id, dir });
}
export async function handleDetachCli(args, { scriptPath, out = line => writeLineSync(1, line), ...options } = {}) {
  const flags = parseDetachFlags(args);
  if (flags.cancel !== undefined) {
    const result = await cancelOp({ ...options, id: flags.cancel, maxWaitMs: flags.maxWaitMs });
    out(JSON.stringify(result));
    return result.code;
  }
  if (flags.waitFor !== null) {
    const result = await waitForOp({ ...options, id: flags.waitFor, maxWaitMs: flags.maxWaitMs });
    out(JSON.stringify(result));
    return result.code;
  }
  if (!flags.detach) return null;
  const record = await startDetachedOp({ ...options, argv: [process.execPath, scriptPath, ...flags.rest] });
  out(JSON.stringify(record));
  return 0;
}
function readRecord(path) { return JSON.parse(readFileSync(path, 'utf8')); }
function cancellationRequested(path) {
  try {
    if (readFileSync(`${path}.cancel`, 'utf8').trim() !== 'SIGTERM') throw new Error('invalid-cancellation-request');
    return true;
  }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
function finishRecord(path, record, cleanup, exitCode, reason) {
  if (!cleanup.complete) { exitCode = 1; reason = 'escaped-descendants'; }
  writeRecord(path, { ...record, members: cleanup.members, status: exitCode === 0 ? 'done' : 'failed',
    exitCode, ...(reason ? { reason } : {}), cleanup: cleanup.complete ? 'observed-owners-stopped' : 'incomplete',
    containment: 'best-effort',
    containmentLimit: 'Descendants that remove the marker, close logs and reparent before observation may escape; cgroups deferred.' });
}

/** One detached reaper owns the O_EXCL receipt for the job's lifetime. No TTL takeover:
 * a paused owner must never resume alongside a second terminal writer. */
export async function reapRecord(path, { probe = probeRunner, sweep = sweepOwnedProcesses,
  pause = sleep } = {}) {
  let lock;
  try { lock = openSync(`${path}.reaper`, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') return; throw error; }
  try {
    writeFileSync(lock, JSON.stringify({ ready: true, pid: process.pid }));
    for (;;) {
      let record = readRecord(path);
      if (record.status !== 'running') return;
      const alive = await probe(record.pid, record, { deadline: Date.now() + PROBE_MS });
      if (alive === false) {
        // The runner publishes before exiting; terminal state wins this race.
        record = readRecord(path);
        if (record.status !== 'running') return;
        const cleanup = await sweep(record);
        finishRecord(path, record, cleanup, 137, 'runner-died');
        return;
      }
      await pause(100);
    }
  } finally { closeSync(lock); }
}

async function runRecord(args) {
  const path = args[0].slice('--run-record='.length);
  const handlers = new Map();
  const codes = { SIGTERM: 143, SIGINT: 130, SIGHUP: 129 };
  let signal = null, record, child, outcome = null;
  const stop = value => {
    if (signal) return;
    signal = value;
    if (record?.commandIdentity) void signalIdentity(record.commandIdentity, signal);
  };
  for (const value of Object.keys(codes)) {
    const handler = () => stop(value);
    handlers.set(value, handler);
    process.on(value, handler);
  }
  const fds = [];
  try {
    const startupDeadline = Date.now() + 5000;
    for (;;) {
      record = readRecord(path);
      if (record.pid === process.pid) break;
      if (Date.now() >= startupDeadline) throw new Error('launcher did not initialize runner record');
      await sleep(25);
    }
    record.runnerIdentity = (await readProcess(process.pid, { scope: path })).identity;
    if (!record.runnerIdentity) throw new Error('runner-identity-unavailable');
    writeRecord(path, record);
    for (;;) {
      try { if (readRecord(`${path}.reaper`).ready === true) break; }
      catch (error) { if (!(error instanceof SyntaxError) && error.code !== 'ENOENT') throw error; }
      if (Date.now() >= startupDeadline) throw new Error('reaper-unavailable');
      await sleep(25);
    }
    if (cancellationRequested(path)) stop('SIGTERM');
    if (!signal) {
      fds.push(openSync(record.stdoutPath, 'a'));
      fds.push(openSync(record.stderrPath, 'a'));
      const argv = args.slice(args.indexOf('--') + 1);
      child = spawn(argv[0], argv.slice(1), { detached: true, stdio: ['ignore', ...fds],
        env: { ...process.env, WE_DETACHED_OP: record.id } });
      child.once('error', () => { outcome = 1; });
      child.once('exit', code => { outcome = code ?? 1; });
      record.commandIdentity = (await readProcess(child.pid, { scope: path })).identity ?? null;
      // Persist the command identity before any asynchronous descendant discovery.
      writeRecord(path, record);
      if (signal) await signalIdentity(record.commandIdentity, signal);
      while (outcome === null && !signal) {
        if (cancellationRequested(path)) { stop('SIGTERM'); break; }
        const snapshot = await collectOwnedProcesses(record);
        const known = new Map([...(record.members || []), ...snapshot.members].map(p => [identityKey(p), p]));
        record.ownershipIncomplete ||= known.size > MAX_PROCESSES;
        record.members = [...known.values()].slice(0, MAX_PROCESSES);
        writeRecord(path, record);
        if (outcome === null && !signal) await sleep(100);
      }
    }
    const cleanup = child ? await sweepOwnedProcesses(record, { signal: signal || 'SIGTERM' })
      : { complete: true, members: [] };
    const exitCode = signal ? codes[signal] : outcome ?? 1;
    finishRecord(path, record, cleanup, exitCode, signal ? 'cancelled' : null);
    process.exitCode = cleanup.complete ? exitCode : 1;
  } catch (error) {
    if (record?.pid === process.pid) {
      // No command is launched until both identity and reaper are established.
      const cleanup = child ? await sweepOwnedProcesses(record) : { complete: true, members: [] };
      finishRecord(path, record, cleanup, 1, error.message);
    }
    process.exitCode = 1;
  } finally {
    for (const fd of fds) closeSync(fd);
    for (const [value, handler] of handlers) process.removeListener(value, handler);
    // A known escaped child must not keep the record writer alive indefinitely.
    child?.unref();
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const task = args[0]?.startsWith('--reap-record=') ? reapRecord(args[0].slice(14)) : runRecord(args);
  task.catch(error => { console.error(error.message); process.exitCode = 1; });
}
