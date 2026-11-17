import { stripVTControlCharacters } from 'node:util';

/** Context only: strip terminal escapes and retain a UTF-8-safe tail within both bounds.
 * Oversized logs explicitly direct the fixer to the full job log. */
export function boundedCiLogTail(text, { maxLines = 400, maxBytes = 16_000 } = {}) {
  const clean = stripVTControlCharacters(String(text ?? ''));
  const lines = clean.split('\n');
  const note = '… [log tail truncated; inspect the full job log for earlier context]\n';
  const truncated = lines.length > maxLines || Buffer.byteLength(clean) > maxBytes;
  if (!truncated) return clean;
  const tail = Buffer.from(lines.slice(-Math.max(1, maxLines - 1)).join('\n'));
  const room = Math.max(0, maxBytes - Buffer.byteLength(note));
  let start = Math.max(0, tail.length - room);
  while (start < tail.length && (tail[start] & 0xc0) === 0x80) start++;
  return note + tail.subarray(start).toString('utf8');
}
