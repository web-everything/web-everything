import { stripVTControlCharacters } from 'node:util';

// Date.parse normalizes invalid calendar dates. Require the canonical UTC date too,
// while accepting Actions' sub-millisecond log timestamps.
function ciTimestamp(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?Z$/.exec(value);
  if (!match) return null;
  const canonical = `${match[1]}.${(match[2] ?? '').padEnd(3, '0').slice(0, 3)}Z`;
  const time = Date.parse(canonical);
  return Number.isFinite(time) && new Date(time).toISOString() === canonical ? time : null;
}

/** Attribute a whole Actions log using the numbered, terminal job-step inventory.
 * Reject partial or ambiguous evidence rather than guessing ownership from step names
 * or carrying ownership across untimestamped lines. Untimed skipped steps own nothing.
 * This is evidence for eligibility, unlike the context-only extractors below.
 */
export function attributeCiJobLog(log, steps) {
  const failedSteps = [];
  const unknown = reason => ({ complete: false, reason, failedSteps });
  if (!Array.isArray(steps) || !steps.length) return unknown('missing-step-metadata');
  if (steps.length > 512) return unknown('step-metadata-limit');
  const ranges = [];
  let previousNumber = 0;
  for (const step of steps) {
    if (!step || !Number.isSafeInteger(step.number) || step.number <= previousNumber
        || typeof step.name !== 'string' || !step.name.trim() || step.name.length > 4096
        || step.status !== 'completed' || !['success', 'failure', 'neutral', 'skipped'].includes(step.conclusion)) {
      return unknown('invalid-step-metadata');
    }
    previousNumber = step.number;
    const identity = { number: step.number, name: step.name };
    if (step.conclusion === 'failure') failedSteps.push(identity);
    if (step.conclusion === 'skipped' && step.started_at == null && step.completed_at == null) continue;
    const start = ciTimestamp(step.started_at), end = ciTimestamp(step.completed_at);
    if (start === null || end === null || start > end) return unknown('invalid-step-boundaries');
    if (ranges.length && start < ranges.at(-1).end) return unknown('overlapping-step-boundaries');
    ranges.push({ step: identity, failed: step.conclusion === 'failure', start, end, lines: [] });
  }
  if (!failedSteps.length) return unknown('missing-failed-step');
  if (typeof log !== 'string' || Buffer.byteLength(log) > 2 * 1024 * 1024) return unknown('job-log-limit');
  const rawLines = log.split('\n');
  if (rawLines.some(line => line.length > 16 * 1024)) return unknown('job-log-line-limit');
  let first = null, last = null;
  for (const raw of rawLines) {
    const line = stripVTControlCharacters(raw).trimEnd();
    if (!line.trim()) continue;
    if (/\btruncated\b/i.test(line)) return unknown('truncated-job-log');
    const match = /^(\S+)[ \t](.*)$/.exec(line);
    const time = ciTimestamp(match?.[1]);
    if (time === null) return unknown('missing-or-invalid-log-timestamp');
    if (last !== null && time < last) return unknown('nonmonotonic-log-timestamps');
    first ??= time;
    last = time;
    const owners = ranges.filter(range => time >= range.start && time <= range.end);
    if (owners.length > 1) return unknown('ambiguous-step-boundary');
    if (!owners.length) {
      if ((time >= ranges[0].start && time <= ranges.at(-1).end)
          // Keep the whole-job parser's fatal diagnostics: no step can account
          // for an unowned suite failure or unhandled error before/after its run.
          || /Failed Suites|Unhandled Errors|Unhandled Rejection/i.test(match[2])
          || /^(?:FAIL\b|Error:|AssertionError:|Tests\s+\d+\s+failed\b|##\[error\])/.test(match[2].trim())) {
        return unknown('unowned-log-output');
      }
      continue;
    }
    if (owners[0].failed) owners[0].lines.push(match[2]);
  }
  if (first === null || first > ranges[0].start || last < ranges.at(-1).end) return unknown('incomplete-job-log-boundaries');
  return { complete: true, failedSteps, logs: ranges.filter(range => range.failed)
    .map(({ step, lines }) => ({ step, log: lines.join('\n') })) };
}

/** The failing test lines a vitest / node log names, de-duplicated in log order.
 * includeErrors also retains diagnostics for context, without asserting step attribution. */
export function extractFailedTests(log, max = 12, { includeErrors = false, maxBytes = Infinity } = {}) {
  const out = [], seen = new Set();
  let bytes = 0;
  for (const raw of stripVTControlCharacters(String(log ?? '')).split('\n')) {
    if (out.length >= max || bytes >= maxBytes) break;
    const line = raw.replace(/^.*?\d{4}-\d\d-\d\dT[\d:.]+Z\s?/, '').trim();
    if (!/^(FAIL|❯ .*\.test\.|×|✗|✕)\s/.test(line)
      && !(includeErrors && /AssertionError|Error:|##\[error\]/.test(line))) continue;
    // Preserve the extractor's per-line cap without splitting a surrogate pair.
    const clipped = line.slice(0, 240).replace(/[\uD800-\uDBFF]$/, '');
    if (seen.has(clipped)) continue;
    seen.add(clipped);
    const room = maxBytes - bytes - (out.length ? 1 : 0);
    if (room <= 0) break;
    const buffer = Buffer.from(clipped);
    let end = Math.min(buffer.length, room);
    while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
    if (!end) break;
    const excerpt = buffer.subarray(0, end).toString('utf8');
    bytes += Buffer.byteLength(excerpt) + (out.length ? 1 : 0);
    out.push(excerpt);
  }
  return out;
}

/** Context only: retain full-log diagnostics BEFORE a UTF-8-safe tail, within both bounds.
 * Reserve the notice and tail first; diagnostics use only the remaining bytes (at most 40 lines / 8 KB).
 * Reapplying a smaller bound preserves diagnostics through staging and prompt rendering. */
export function boundedCiLogTail(text, { maxLines = 400, maxBytes = 16_000 } = {}) {
  const clean = stripVTControlCharacters(String(text ?? ''));
  const lines = clean.split('\n');
  const note = maxLines > 1
    ? '… [log tail truncated; inspect the full job log for earlier context]\n' : '';
  const truncated = lines.length > maxLines || Buffer.byteLength(clean) > maxBytes;
  if (!truncated) return clean;
  if (maxLines <= 0 || maxBytes <= 0) return '';
  const noteBuffer = Buffer.from(note);
  if (maxBytes <= noteBuffer.length) {
    let end = maxBytes;
    while (end > 0 && (noteBuffer[end] & 0xc0) === 0x80) end--;
    return noteBuffer.subarray(0, end).toString('utf8');
  }
  const available = maxBytes - noteBuffer.length;
  const lastContentIndex = lines.findLastIndex(line => line.trim());
  const lastLine = lines[lastContentIndex] ?? '';
  const finalFailureBytes = extractFailedTests(lastLine, 1, { includeErrors: true }).length
    ? Buffer.byteLength(lines.slice(lastContentIndex).join('\n')) : 0;
  // Keep at least half the remaining budget for context, expanding it to fit a final
  // failure line. An oversized failure keeps its end; ordinary cleanup still leaves
  // space for earlier diagnostics even when its final line is oversized.
  const tailReserve = Math.min(available, Math.max(Math.ceil(available / 2), finalFailureBytes));
  const excerpt = extractFailedTests(clean, Math.min(40, Math.max(0, maxLines - 2)), {
    includeErrors: true, maxBytes: Math.min(8000, available - tailReserve) - 1,
  });
  const prefix = (excerpt.length ? excerpt.join('\n') + '\n' : '') + note;
  const tail = Buffer.from(lines.slice(-Math.max(1, maxLines - excerpt.length - (note ? 1 : 0))).join('\n'));
  const room = Math.max(0, maxBytes - Buffer.byteLength(prefix));
  let start = Math.max(0, tail.length - room);
  while (start < tail.length && (tail[start] & 0xc0) === 0x80) start++;
  return prefix + tail.subarray(start).toString('utf8');
}
