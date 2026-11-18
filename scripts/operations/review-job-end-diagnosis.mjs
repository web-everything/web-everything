/** Bounded, read-only evidence collection; no job lifecycle decisions live here. */
import { closeSync, fstatSync, mkdirSync, openSync, readSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { diagnosticPath, jobLogPath, reviewJobsDir } from './review-job-store.mjs';
import { redactSpawnText } from '../lib/describe-spawn-failure.mjs';

const UNKNOWN = 'unknown (no exit marker: killed hard or crashed)';
const MAX_TAIL = 8192;

export function diagnoseEndedJob({ slug, pid, dir = reviewJobsDir() }) {
  let marker;
  try {
    const value = JSON.parse(readFileSync(diagnosticPath(slug, dir, 'exit'), 'utf8'));
    if (value.pid === pid) marker = value;
  } catch { /* Missing, stale or unreadable evidence cannot identify the exit. */ }
  let tail = '';
  let fd;
  try {
    fd = openSync(jobLogPath(slug, dir), 'r');
    const size = fstatSync(fd).size;
    // Redact the WHOLE log (never a suffix: a multiline credential container needs its opening context). A log
    // over the cap cannot be redacted safely, so it yields a fixed pointer instead of any content.
    let text;
    if (size > 4 * 1024 * 1024) text = '[log too large to redact safely; inspect job log]';
    else {
      const bytes = Buffer.alloc(size);
      const read = readSync(fd, bytes, 0, size, 0);
      text = bytes.subarray(0, read).toString('utf8');
    }
    // Strip control characters BEFORE redacting (a split credential must be whole to match), and redact once more after.
    text = redactSpawnText(redactSpawnText(text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '')));
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
  const path = diagnosticPath(slug, dir, 'ended');
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ pid, ...diagnosis }, null, 2)}\n`);
  renameSync(tmp, path);
}
