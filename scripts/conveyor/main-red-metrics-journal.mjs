import { mkdirSync, opendirSync, openSync, readSync, closeSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAIN_RED_METRIC_LIMITS, validMainRedMetric } from './main-ci-red-core.mjs';

export const metricRecovery = 'Incomplete metric journal; archive journal and replay a smaller range or recover source evidence.';

/** Bounded directory iterator, including unknown entries in the scan budget. No unbounded readdir. */
function metricFiles(dir, { limit = MAIN_RED_METRIC_LIMITS.events, openDir = opendirSync } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAIN_RED_METRIC_LIMITS.events) throw new Error('invalid scan limit');
  const entries = []; const handle = openDir(join(dir, 'main-red-metrics'));
  try {
    let entry;
    while ((entry = handle.readSync())) {
      if (entries.length >= limit) throw new Error('scan limit');
      if (!entry.isFile() || !entry.name.endsWith('.json')) throw new Error('malformed entry');
      entries.push(entry.name);
    }
  } finally { handle.closeSync(); }
  return entries;
}

// A pre-read stat cannot bound bytes if a competing writer grows the file. Read at most
// 8 KiB plus one overflow byte through the descriptor, including acknowledgement retries.
function readMetricFile(path, read = readSync) {
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(MAIN_RED_METRIC_LIMITS.bytes + 1);
    let used = 0;
    while (used < buffer.length) {
      const count = read(fd, buffer, used, buffer.length - used, used);
      if (!count) break;
      used += count;
    }
    if (used > MAIN_RED_METRIC_LIMITS.bytes) throw new Error('oversized event');
    return JSON.parse(buffer.subarray(0, used).toString('utf8'));
  } finally { closeSync(fd); }
}

/** Append-only immutable events. O_EXCL makes retries idempotent, including journal-success/state-failure.
 * Refuse at 10,000 files rather than deleting history. Operator archives before collection resumes.
 * Measurement failure is diagnostic only: it never grants dispatch/merge or changes alert authority.
 */
export function appendMainRedMetrics(dir, events, { writeFile = writeFileSync,
  limit = MAIN_RED_METRIC_LIMITS.events, openDir = opendirSync } = {}) {
  const warnings = [];
  try {
    if (!Array.isArray(events) || events.length > MAIN_RED_METRIC_LIMITS.events) throw new Error('event limit');
    mkdirSync(join(dir, 'main-red-metrics'), { recursive: true });
    let count = metricFiles(dir, { limit, openDir }).length;
    for (const event of events) {
      if (!validMainRedMetric(event)) throw new Error('malformed event');
      const text = JSON.stringify(event);
      if (Buffer.byteLength(text) > MAIN_RED_METRIC_LIMITS.bytes) throw new Error('oversized event');
      const path = join(dir, 'main-red-metrics', `${event.key}.json`);
      const acknowledge = () => {
        const saved = readMetricFile(path);
        // Only the polling timestamp may advance on a state-write retry. Every
        // transition field, including origin and timing sample, must still agree.
        const fields = ['v', 'key', 'repo', 'head', 'seq', 'runId', 'kind', 'since', 'signature', 'truncated'];
        if (!validMainRedMetric(saved) || fields.some(key => saved[key] !== event[key])
          || ['waitMs', 'serviceMs'].some(key => saved.queue[key] !== event.queue[key]))
          throw new Error('conflicting existing event');
      };
      try { acknowledge(); continue; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (count >= limit) throw new Error('event limit');
      try { writeFile(path, text, { flag: 'wx', mode: 0o600 }); count++; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        acknowledge(); // The competing writer may have left partial or conflicting evidence.
      }
    }
    metricFiles(dir, { limit, openDir }); // Re-count after writes: concurrent overflow refuses, never deletes.
  } catch { warnings.push(metricRecovery); }
  return { warnings };
}

/** Read-only journal evidence. Every skipped or unreadable byte leaves an operator-visible warning. */
export function readMainRedMetrics(dir, { limit = MAIN_RED_METRIC_LIMITS.events, openDir = opendirSync,
  read = readSync } = {}) {
  const events = []; const warnings = [];
  try {
    for (const name of metricFiles(dir, { limit, openDir })) {
      const path = join(dir, 'main-red-metrics', name);
      try {
        const event = readMetricFile(path, read);
        if (!validMainRedMetric(event)) throw new Error('malformed event');
        if (name !== `${event.key}.json`) throw new Error('filename/key mismatch');
        events.push(event);
      } catch (error) {
        warnings.push(error.message === 'oversized event'
          ? 'Incomplete oversized event; archive journal and recover source evidence.'
          : error.message === 'filename/key mismatch'
          ? 'Incomplete filename/key mismatch; archive journal and recover source evidence.'
          : 'Incomplete malformed/unreadable event; archive journal and recover source evidence.');
      }
    }
  } catch { warnings.push(metricRecovery); }
  return { events, warnings: [...new Set(warnings)] };
}

