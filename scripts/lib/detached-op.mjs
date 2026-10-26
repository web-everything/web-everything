/**
 * @file Resumable detached commands with atomic lifecycle records and bounded foreground waits.
 * The private --run-record entry point owns command execution and records its terminal exit code.
 *
 * Bounds (best-effort, stated exactly):
 * - Runner identity: the runner records its own start time (`ps -o lstart=`, 1 s resolution) as `pidStart`.
 *   `waitForOp` treats a live pid whose start time differs as a dead runner (`runner-died`), so a reused PID
 *   cannot look "running" forever. A record without `pidStart` (older runner, or `ps` unavailable) is checked
 *   by liveness only, and a live pid whose start time cannot be read is given the benefit of the doubt.
 *   A reused pid that also starts within the same second as the original runner is indistinguishable.
 * - Command stop: SIGKILL of the command's process tree and process group, plus every descendant seen by a
 *   periodic snapshot (every 250 ms, pid + start time) whose start time still matches at stop time. A
 *   descendant that detaches (setsid) and is re-parented to PID 1 is therefore stopped, UNLESS it was created
 *   and orphaned (its parent exited) within one snapshot interval, before any snapshot saw it: that race is not
 *   closed. Its descendants spawned later are covered only if the survivor itself was snapshotted.
 *   A SIGKILLed runner cleans nothing up. DETACHED_OP_SNAPSHOT_MS overrides the interval (test seam).
 */
import { execFileSync, spawn } from 'node:child_process';
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { descendantPids, killProcessTree } from './bounded-child.mjs';

const SNAPSHOT_MS = 250;
const psEnv = () => ({ ...process.env, LC_ALL: 'C' });
const psAll = () => execFileSync('ps', ['-A', '-o', 'pid=,ppid=,pgid=,lstart='],
  { encoding: 'utf8', timeout: 10_000, env: psEnv() });
const startsFromPs = text => {
  const starts = new Map();
  for (const line of String(text).split('\n')) {
    const m = /^\s*(\d+)\s+\d+\s+\d+\s+(\S.*?)\s*$/.exec(line);
    if (m) starts.set(Number(m[1]), m[2]);
  }
  return starts;
};
/** Process start time as printed by ps (stable for the life of a pid), or null when unreadable. */
export function processStart(pid) {
  try {
    return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)],
      { encoding: 'utf8', timeout: 5000, env: psEnv(), stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch { return null; }
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
  for (const arg of args) {
    if (arg === '--detach') flags.detach = true;
    else if (arg.startsWith('--wait-for=')) flags.waitFor = arg.slice(11);
    else if (arg.startsWith('--max-wait-ms=')) flags.maxWaitMs = budget(arg.slice(14));
    else flags.rest.push(arg);
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
function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'EPERM') return true; if (error.code === 'ESRCH') return false; throw error; }
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
  spawnFn = spawn, now = Date.now, random = randomUUID } = {}) {
  if (!Array.isArray(argv) || !argv.length) throw new Error('command required');
  dir = resolve(dir);
  mkdirSync(dir, { recursive: true });
  const id = `${now()}-${String(random()).replace(/[^A-Za-z0-9_-]/g, '')}`;
  const path = recordPath(dir, id);
  const record = { id, kind, status: 'running', pid: process.pid, startedAt: new Date(now()).toISOString(),
    exitCode: null, stdoutPath: join(dir, `${id}.stdout.log`), stderrPath: join(dir, `${id}.stderr.log`) };
  const fds = [];
  try {
    fds.push(openSync(record.stdoutPath, 'w', 0o600));
    fds.push(openSync(record.stderrPath, 'w', 0o600));
    writeRecord(path, record);
    const child = spawnFn(process.execPath, [fileURLToPath(import.meta.url), `--run-record=${path}`, '--', ...argv],
      { detached: true, stdio: ['ignore', ...fds], env });
    if (child.once) await new Promise((done, reject) => { child.once('spawn', done); child.once('error', reject); });
    record.pid = child.pid;
    writeRecord(path, record);
    child.unref();
    return record;
  } finally { for (const fd of fds) closeSync(fd); }
}
export async function waitForOp({ id, maxWaitMs = 540000, dir = resolveDetachedOpsDir(),
  now = Date.now, sleep: pause = sleep, isAlive = alive, startOf = processStart } = {}) {
  const deadline = now() + budget(maxWaitMs);
  const readRecord = () => {
    const record = JSON.parse(readFileSync(recordPath(dir, id), 'utf8'));
    if (record.id !== id || !['running', 'done', 'failed'].includes(record.status)
      || !Number.isInteger(record.pid) || record.pid <= 0
      || (record.pidStart !== undefined && typeof record.pidStart !== 'string')
      || typeof record.stdoutPath !== 'string' || typeof record.stderrPath !== 'string'
      || (record.status === 'running' && record.exitCode !== null)
      || (record.status === 'done' && record.exitCode !== 0)
      || (record.status === 'failed' && (!Number.isInteger(record.exitCode) || record.exitCode <= 0))) {
      throw new Error('incomplete job record');
    }
    return record;
  };
  // A reused pid is alive but is not the runner: its start time no longer matches the recorded one.
  const runnerGone = ({ pid, pidStart }) => {
    if (!isAlive(pid)) return true;
    if (!pidStart) return false;
    const start = startOf(pid);
    return start !== null && start !== undefined && start !== pidStart;
  };
  for (;;) {
    let record;
    let deadRunnerPid;
    try {
      record = readRecord();
      if (record.status === 'running' && runnerGone(record)) {
        deadRunnerPid = record.pid;
        // The runner publishes its terminal record before exiting. Refresh after
        // observing death so a stale running snapshot cannot hide that result.
        record = readRecord();
      }
    } catch (error) { return { id, status: 'failed', code: 1, reason: error.code === 'ENOENT' ? 'unknown-job' : 'invalid-record' }; }
    const result = { ...record, stdoutTail: tail(record.stdoutPath), stderrTail: tail(record.stderrPath) };
    if (record.status !== 'running') return { ...result, code: record.status === 'done' ? 0 : 1 };
    if (record.pid === deadRunnerPid) return { ...result, status: 'failed', code: 1, reason: 'runner-died' };
    if (now() >= deadline) return { ...result, code: 75 };
    await pause(Math.min(1000, deadline - now()));
  }
}
export async function handleDetachCli(args, { scriptPath, out = console.log, ...options } = {}) {
  const flags = parseDetachFlags(args);
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
async function runRecord(args) {
  const path = args[0].slice('--run-record='.length);
  let record;
  let child;
  let interrupted = 0;
  const fds = [];
  let exitCode = 1;
  // pid -> start time of every command descendant a snapshot has seen, kept after its parent exits.
  const watched = new Map();
  const snapshot = () => {
    if (!child?.pid) return;
    try {
      const text = psAll();
      const starts = startsFromPs(text);
      // Roots: the command, plus watched survivors (re-parented) whose pid still has the same start time.
      const roots = [child.pid, ...[...watched].filter(([pid, start]) => starts.get(pid) === start).map(([pid]) => pid)];
      for (const root of roots) {
        for (const pid of [root, ...descendantPids(root, text)]) {
          if (starts.has(pid) && pid > 1 && pid !== process.pid) watched.set(pid, starts.get(pid));
        }
      }
    } catch { /* ps unavailable: the tree/group kill below still applies */ }
  };
  const sweepWatched = () => {
    if (!watched.size) return;
    let starts;
    try { starts = startsFromPs(psAll()); } catch { return; }
    // Only pids that still carry the recorded start time: a reused pid is never killed.
    for (const [pid, start] of watched) {
      if (starts.get(pid) === start) killProcessTree(pid, 'SIGKILL');
    }
  };
  const stopCommand = () => {
    if (!child?.pid) return;
    snapshot();
    // Kill the tree first, including descendants in separate process groups, then
    // the command group to catch children reparented when their parent exited.
    killProcessTree(child.pid, 'SIGKILL');
    try { process.kill(-child.pid, 'SIGKILL'); }
    // macOS answers EPERM, not ESRCH, for a group whose only member is the just-killed, unreaped leader.
    catch (error) { if (error.code !== 'ESRCH' && error.code !== 'EPERM') throw error; }
    // Then descendants that detached and were re-parented to PID 1, which neither kill reaches.
    sweepWatched();
  };
  const snapshotMs = Number(process.env.DETACHED_OP_SNAPSHOT_MS) > 0 ? Number(process.env.DETACHED_OP_SNAPSHOT_MS) : SNAPSHOT_MS;
  let snapshotTimer;
  const handlers = [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]].map(([signal, code]) => {
    const handler = () => { interrupted ||= code; stopCommand(); };
    process.on(signal, handler);
    return [signal, handler];
  });
  process.on('exit', stopCommand);
  try {
    const deadline = Date.now() + 5000;
    do {
      record = JSON.parse(readFileSync(path, 'utf8'));
      if (record.pid === process.pid) break;
      if (Date.now() >= deadline) throw new Error('launcher did not initialize runner record');
      await sleep(25);
    } while (true);
    // Claimed: stamp our start time so waitForOp can tell this runner from a later holder of the pid.
    const pidStart = processStart(process.pid);
    if (pidStart) { record = { ...record, pidStart }; writeRecord(path, record); }
    fds.push(openSync(record.stdoutPath, 'a'));
    fds.push(openSync(record.stderrPath, 'a'));
    const argv = args.slice(args.indexOf('--') + 1);
    exitCode = interrupted || await new Promise((done, reject) => {
      child = spawn(argv[0], argv.slice(1), { detached: true, stdio: ['ignore', ...fds] });
      child.once('error', reject);
      snapshotTimer = setInterval(snapshot, snapshotMs);
      snapshotTimer.unref();
      // A signal must never publish failure before the killed child is reaped.
      child.once('close', code => done(interrupted || (code ?? 1)));
    });
  } catch (error) { console.error(error.message); }
  finally {
    clearInterval(snapshotTimer);
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
    process.removeListener('exit', stopCommand);
    for (const fd of fds) closeSync(fd);
  }
  if (record?.pid === process.pid) {
    writeRecord(path, { ...record, status: exitCode === 0 ? 'done' : 'failed', exitCode });
  }
  process.exitCode = exitCode;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runRecord(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
