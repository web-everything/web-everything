import { stripVTControlCharacters } from 'node:util';

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
 * The excerpt uses at most 40 lines / 8 KB and half the byte budget, leaving room for the tail.
 * Reapplying a smaller bound preserves diagnostics through staging and prompt rendering. */
export function boundedCiLogTail(text, { maxLines = 400, maxBytes = 16_000 } = {}) {
  const clean = stripVTControlCharacters(String(text ?? ''));
  const lines = clean.split('\n');
  const note = maxLines > 1 && maxBytes >= 100
    ? '… [log tail truncated; inspect the full job log for earlier context]\n' : '';
  const truncated = lines.length > maxLines || Buffer.byteLength(clean) > maxBytes;
  if (!truncated) return clean;
  if (maxLines <= 0 || maxBytes <= 0) return '';
  const excerpt = extractFailedTests(clean, Math.min(40, Math.max(0, maxLines - 2)), {
    includeErrors: true, maxBytes: Math.min(8000, Math.floor(maxBytes / 2)) - 1,
  });
  const prefix = (excerpt.length ? excerpt.join('\n') + '\n' : '') + note;
  const tail = Buffer.from(lines.slice(-Math.max(1, maxLines - excerpt.length - (note ? 1 : 0))).join('\n'));
  const room = Math.max(0, maxBytes - Buffer.byteLength(prefix));
  let start = Math.max(0, tail.length - room);
  while (start < tail.length && (tail[start] & 0xc0) === 0x80) start++;
  return prefix + tail.subarray(start).toString('utf8');
}
