/** Bounded, read-only evidence collection; no job lifecycle decisions live here. */
import { closeSync, fstatSync, mkdirSync, openSync, readSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { jobLogPath, jobRecordPath, reviewJobsDir } from './review-job-store.mjs';
import { redactSpawnText } from '../lib/describe-spawn-failure.mjs';

const UNKNOWN = 'unknown (no exit marker: killed hard or crashed)';
const MAX_TAIL = 8192;

export function diagnoseEndedJob({ slug, pid, dir = reviewJobsDir() }) {
  let marker;
  try {
    const value = JSON.parse(readFileSync(jobRecordPath(slug, dir).replace(/\.json$/, '.exit.json'), 'utf8'));
    if (value.pid === pid) marker = value;
  } catch { /* Missing, stale or unreadable evidence cannot identify the exit. */ }
  let tail = '';
  let fd;
  try {
    fd = openSync(jobLogPath(slug, dir), 'r');
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - 64 * 1024);
    const bytes = Buffer.alloc(size - start);
    const read = readSync(fd, bytes, 0, bytes.length, start);
    let text = bytes.subarray(0, read).toString('utf8');
    // Drop a partial first line (possibly a partial credential). An oversized final line names the fallback.
    if (start > 0) text = text.includes('\n') ? text.slice(text.indexOf('\n') + 1) : '[log line exceeds diagnostic read bound; inspect job log]';
    text = redactSpawnText(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
    tail = text.replace(/\n$/, '').split('\n').slice(-40).join('\n');
    if (Buffer.byteLength(tail) > MAX_TAIL) tail = Buffer.from(tail).subarray(-MAX_TAIL + 3).toString('utf8');
  } catch { /* Missing logs are normal for a job that failed before writing. */ }
  finally { if (fd !== undefined) closeSync(fd); }
  const lines = tail.split('\n').filter(line => line.trim());
  const lastErrorLine = (lines.filter(line => /error|exception|fatal|ETIMEDOUT|ENOENT|killed|timed out/i.test(line)).at(-1)
    ?? lines.at(-1) ?? '').slice(0, 200);
  return { exitCode: marker ? marker.exitCode : UNKNOWN, signal: marker ? marker.signal : UNKNOWN,
    marker: Boolean(marker), lastErrorLine, tail };
}

/** Pure, terminal-safe single-line summary of the collected evidence. */
export function summarizeDiagnosis(d) {
  const safe = value => String(value ?? '?').replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, ' ');
  return `exit=${safe(d.exitCode)} signal=${safe(d.signal)} last=${JSON.stringify(safe(d.lastErrorLine))}`;
}

/** Atomic run record, separate from the live job record. */
export function writeEndedJobDiagnosis({ slug, pid, dir = reviewJobsDir() }, diagnosis) {
  const path = jobRecordPath(slug, dir).replace(/\.json$/, '.ended.json');
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ pid, ...diagnosis }, null, 2)}\n`);
  renameSync(tmp, path);
}
