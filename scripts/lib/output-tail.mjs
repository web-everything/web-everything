/**
 * @file scripts/lib/output-tail.mjs
 * @description Rolling, bounded, secret-scrubbed tail of a gate's combined output. verify-lane persists it in the
 *   run record when a phase times out or is killed, so the next timeout names the test file that was running.
 *   Scrubbing is per line with `scrubPublish` (secret-shaped lines only; test file names are kept).
 */
import { scrubPublish } from './secret-scrub.mjs';

export const OUTPUT_TAIL_LINES = 200;
export const OUTPUT_TAIL_MAX_BYTES = 32 * 1024;
export const OUTPUT_TAIL_MAX_LINE_CHARS = 400;
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

const HARD_LINE_CHARS = 4096;
const OVERLONG = '[line over 4096 chars omitted]';

export function createOutputTail({ maxLines = OUTPUT_TAIL_LINES, maxBytes = OUTPUT_TAIL_MAX_BYTES, maxLineChars = OUTPUT_TAIL_MAX_LINE_CHARS } = {}) {
  let lines = [];
  // One partial-line buffer per stream, so interleaved stdout/stderr chunks never splice a line (or a secret) together.
  const partials = new Map();
  // A line is scrubbed whole, then clipped: clipping first could leave a secret fragment the scrubber no longer recognises.
  const tidy = (line) => {
    if (line.length > HARD_LINE_CHARS) return OVERLONG;
    const clean = line.replace(ANSI, '');
    let safe;
    try { safe = scrubPublish(clean).length ? '[redacted: secret-shaped line]' : clean; } catch { safe = '[redacted: unscrubbable line]'; }
    return safe.length > maxLineChars ? safe.slice(0, maxLineChars) : safe;
  };
  return {
    push(chunk, stream = 'out') {
      const text = (partials.get(stream) ?? '') + String(chunk).replace(/\r\n?/g, '\n');
      const parts = text.split('\n');
      const rest = parts.pop();
      partials.set(stream, rest.length > HARD_LINE_CHARS ? OVERLONG : rest);
      for (const part of parts) lines.push(tidy(part));
      if (lines.length > maxLines) lines = lines.slice(-maxLines);
    },
    finish() {
      const out = [...lines, ...[...partials.values()].filter(Boolean).map(tidy)].slice(-maxLines);
      let total = out.reduce((n, l) => n + Buffer.byteLength(l) + 1, 0) - 1;
      while (out.length > 1 && total > maxBytes) total -= Buffer.byteLength(out.shift()) + 1;
      return total > maxBytes ? [Buffer.from(out[0]).subarray(-maxBytes).toString('utf8')] : out;
    },
  };
}
