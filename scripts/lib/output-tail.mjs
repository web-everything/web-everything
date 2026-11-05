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

export function createOutputTail({ maxLines = OUTPUT_TAIL_LINES, maxBytes = OUTPUT_TAIL_MAX_BYTES, maxLineChars = OUTPUT_TAIL_MAX_LINE_CHARS } = {}) {
  let lines = [];
  let partial = '';
  const clip = (line) => (line.length > maxLineChars ? line.slice(0, maxLineChars) : line);
  const trim = () => {
    if (lines.length > maxLines) lines = lines.slice(-maxLines);
  };
  return {
    push(chunk) {
      const text = partial + String(chunk).replace(/\r\n?/g, '\n');
      const parts = text.split('\n');
      partial = clip(parts.pop());
      for (const part of parts) lines.push(clip(part));
      trim();
    },
    finish() {
      const all = [...lines, ...(partial ? [partial] : [])].slice(-maxLines).map(l => l.replace(ANSI, ''));
      const scrubbed = all.map(l => {
        try { return scrubPublish(l).length ? '[redacted: secret-shaped line]' : l; } catch { return '[redacted: unscrubbable line]'; }
      });
      // Drop the oldest lines until the joined text fits the byte bound.
      let total = scrubbed.reduce((n, l) => n + l.length + 1, 0) - 1;
      while (scrubbed.length > 1 && total > maxBytes) total -= scrubbed.shift().length + 1;
      return total > maxBytes ? [scrubbed[0].slice(-maxBytes)] : scrubbed;
    },
  };
}
