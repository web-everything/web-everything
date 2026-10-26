/**
 * @file Resumable detached commands with atomic lifecycle records and bounded foreground waits.
 * The private --run-record entry point owns command execution and records its terminal exit code.
 */
import { spawn } from 'node:child_process';
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

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
  now = Date.now, sleep: pause = sleep, isAlive = alive } = {}) {
  const deadline = now() + budget(maxWaitMs);
  for (;;) {
    let record;
    try {
      record = JSON.parse(readFileSync(recordPath(dir, id), 'utf8'));
      if (record.id !== id || !['running', 'done', 'failed'].includes(record.status)
        || !Number.isInteger(record.pid) || record.pid <= 0
        || typeof record.stdoutPath !== 'string' || typeof record.stderrPath !== 'string'
        || (record.status === 'running' && record.exitCode !== null)
        || (record.status === 'done' && record.exitCode !== 0)
        || (record.status === 'failed' && (!Number.isInteger(record.exitCode) || record.exitCode <= 0))) {
        throw new Error('incomplete job record');
      }
    } catch (error) { return { id, status: 'failed', code: 1, reason: error.code === 'ENOENT' ? 'unknown-job' : 'invalid-record' }; }
    const result = { ...record, stdoutTail: tail(record.stdoutPath), stderrTail: tail(record.stderrPath) };
    if (record.status !== 'running') return { ...result, code: record.status === 'done' ? 0 : 1 };
    if (!isAlive(record.pid)) return { ...result, status: 'failed', code: 1, reason: 'runner-died' };
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
  const deadline = Date.now() + 5000;
  let record;
  do {
    record = JSON.parse(readFileSync(path, 'utf8'));
    if (record.pid === process.pid) break;
    if (Date.now() >= deadline) throw new Error('launcher did not initialize runner record');
    await sleep(25);
  } while (true);
  const fds = [];
  let exitCode = 1;
  try {
    fds.push(openSync(record.stdoutPath, 'a'));
    fds.push(openSync(record.stderrPath, 'a'));
    const argv = args.slice(args.indexOf('--') + 1);
    exitCode = await new Promise((done, reject) => {
      const child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', ...fds] });
      child.once('error', reject);
      child.once('exit', code => done(code ?? 1));
    });
  } catch (error) { console.error(error.message); }
  finally { for (const fd of fds) closeSync(fd); }
  writeRecord(path, { ...record, status: exitCode === 0 ? 'done' : 'failed', exitCode });
  process.exitCode = exitCode;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runRecord(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
