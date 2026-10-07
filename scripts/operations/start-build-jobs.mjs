/**
 * @file scripts/operations/start-build-jobs.mjs
 * @description The DURABLE JOB RECORD for a build started by `start-build.mjs` (item 104). One small JSON file
 *   per item under `~/.claude/conveyor/start-build-jobs/<num>.json`, outside any lane or chat session, so the
 *   chat (or `/state`) can read what a detached build is doing after the process that started it has gone.
 *
 * The record holds facts only (pid, lane, session, provider, log path, start time). Whether the job is still
 * running is never stored: it is asked of the kernel each time ({@link describeJob}), the same read the
 * conveyor's double-dispatch guard uses (`detached-dispatch.mjs#defaultIsPidAlive`).
 */
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, existsSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defaultIsPidAlive, detachedHandlePid } from './detached-dispatch.mjs';
import { stripTerminal } from '../lib/pr-state-io.mjs';

export const JOBS_DIR_ENV = 'WE_START_BUILD_JOBS_DIR';

/** Where job records live. */
export function jobsDir(env = process.env) {
  return env[JOBS_DIR_ENV] || join(homedir(), '.claude', 'conveyor', 'start-build-jobs');
}

const safeId = (id) => {
  const s = String(id ?? '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s)) throw new TypeError(`start-build-jobs: unsafe item id ${JSON.stringify(s)}`);
  return s;
};

export function jobPath(id, dir = jobsDir()) { return join(dir, `${safeId(id)}.json`); }

/** Atomic write (temp file + rename) so a reader never sees half a record. */
export function writeJob(job, dir = jobsDir()) {
  mkdirSync(dir, { recursive: true });
  const file = jobPath(job.id, dir);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(job, null, 2)}\n`);
  renameSync(tmp, file);
  return file;
}

export function readJob(id, dir = jobsDir()) {
  try { return JSON.parse(readFileSync(jobPath(id, dir), 'utf8')); } catch { return null; }
}

export function listJobs(dir = jobsDir()) {
  let names;
  try { names = readdirSync(dir); } catch { return []; }
  return names.filter((n) => n.endsWith('.json')).map((n) => readJob(n.slice(0, -5), dir)).filter(Boolean);
}

/** How much of one run's log {@link describeJob} scans for the wrapper's verdict line. */
export const LOG_SCAN_BYTES = 1024 * 1024;

/**
 * The last `bytes` of a log, never reading before `fromOffset` (where THIS run's output starts in a log the
 * item's runs share), or '' when unreadable. Bounded: never reads a whole log. An offset past the end means the
 * log was replaced since, so the whole (new) file is this run's.
 */
export function tailLog(path, bytes = 4096, fromOffset = 0) {
  try {
    if (!path || !existsSync(path)) return '';
    const size = statSync(path).size;
    const floor = Number.isInteger(fromOffset) && fromOffset > 0 && fromOffset <= size ? fromOffset : 0;
    const fd = openSync(path, 'r');
    try {
      const len = Math.min(size - floor, bytes);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      return buf.toString('utf8');
    } finally { closeSync(fd); }
  } catch { return ''; }
}

/**
 * PURE-ish: derive the status of a job. `running` while its pid is alive; otherwise `finished` with the
 * wrapper's own last "finished — <result>" / "FAILED" line when the log has one, else `ended` (gone, no verdict).
 */
export function describeJob(job, { isPidAlive = defaultIsPidAlive, readLog = tailLog } = {}) {
  if (!job) return null;
  const pid = detachedHandlePid(job.handle);
  if (pid && isPidAlive(pid)) return { ...job, status: 'running', detail: `pid ${pid}` };
  const tail = readLog(job.logPath, LOG_SCAN_BYTES, job.logOffset);
  const lines = String(tail).split('\n').map((l) => l.trim()).filter(Boolean);
  // Anchored to this item: agent output echoing some other "deliver-item-run: … finished" text is not the wrapper's verdict.
  const mine = new RegExp(`^deliver-item-run: #${String(job.id).replace(/[^A-Za-z0-9]/g, '')} (finished|FAILED)`);
  const verdict = [...lines].reverse().find((l) => mine.test(l));
  if (verdict) return { ...job, status: /FAILED/.test(verdict) ? 'failed' : 'finished', detail: verdict };
  return { ...job, status: 'ended', detail: 'process gone, no verdict line in log' };
}

/** One-line human rendering, shared by `/state` and the CLI. Every field passes the terminal sanitiser: `detail` is read from the log. */
export function renderJob(described) {
  if (!described) return 'no durable build job';
  return stripTerminal(`durable build ${described.status} — #${described.id}, ${described.provider || 'policy-routed'} in lane ${described.lane} `
    + `(${described.handle}, started ${described.startedAt}); ${described.detail}; log ${described.logPath}`);
}
