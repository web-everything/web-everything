/**
 * @file scripts/lib/log-timestamp.mjs
 * @description #4370 fork 4 — ISO-timestamp every line a daemon writes to its text log. The lease-reaper and
 *   lane-pool-health-watch logs carried no timestamps at all, so on 2026-09-28 a lane reset could only be tied
 *   to a health-watch tick by LINE NUMBER and the HEAD sha in a neighbouring whois verdict. One prefix per line
 *   (not per write) so a multi-line write is still greppable line by line.
 */

/**
 * PURE: prefix every non-empty line of `text` with `nowMs` as an ISO timestamp. Preserves a trailing newline
 * and leaves blank lines blank.
 * @param {string} text
 * @param {number} [nowMs]
 * @returns {string}
 */
export function timestampLines(text, nowMs = Date.now()) {
  const stamp = new Date(nowMs).toISOString();
  return String(text)
    .split('\n')
    .map((line) => (line === '' ? line : `${stamp} ${line}`))
    .join('\n');
}

/** IO: a `process.stderr.write`-shaped writer that timestamps every line it is handed. */
export function timestampedStderr(text) {
  return process.stderr.write(timestampLines(text));
}

/** An ISO-8601 UTC stamp plus its one separating space, at the start of a line (what {@link timestampLines} writes). */
export const LOG_TIMESTAMP_RE = /^\d{4}-\d\d-\d\dT[\d:.]+Z /;

/**
 * PURE (item 68a): drop a leading timestamp so the health parsers' `^name:` anchors still match a stamped daemon
 * log line. Unstamped (old) lines pass through unchanged. Kept in this import-free leaf so read-only modules can
 * reach it through the parsers.
 */
export function stripLogTimestamp(line) {
  return typeof line === 'string' ? line.replace(LOG_TIMESTAMP_RE, '') : line;
}

/**
 * Item 68b: the line a daemon writes when it collapses identical repeats. `<ISO> (repeated N times since <ISO>) <line>`
 * stands for N MORE copies of `<line>` (the first copy was already written in full). Readers call
 * {@link expandRepeatedLines} so tick and attempt counts stay one per occurrence.
 */
export const REPEAT_LINE_RE = /^(?:(\d{4}-\d\d-\d\dT[\d:.]+Z) )?\(repeated (\d+) times since \d{4}-\d\d-\d\dT[\d:.]+Z\) (.*)$/;
/** Per-marker cap, and the cap on EXTRA lines one call may add across all markers (a forged marker can not amplify). */
const MAX_EXPANSION = 100000;
export const MAX_TOTAL_EXPANSION = 200000;

const NO_BREAK_SPACE = String.fromCharCode(0xa0);
/** The marker-shaped start of a line that the daemon did not write itself; {@link neutralizeMarkerText} breaks it. */
const MARKER_SHAPED_RE = /^(\s*(?:\d{4}-\d\d-\d\dT[\d:.]+Z )?\(repeated) (?=\d+ times since )/gm;
/**
 * PURE: break any marker-shaped line inside `text` (a no-break space replaces the space after `(repeated`) so text
 * the daemon merely echoes — child stderr, `gh` output, PR text — can never be mistaken for a collapse marker. Only
 * {@link formatRepeatLine} writes real ones.
 */
export function neutralizeMarkerText(text) {
  const s = String(text ?? '');
  return s.includes('(repeated') ? s.replace(MARKER_SHAPED_RE, (_m, head) => head + NO_BREAK_SPACE) : s;
}

/** PURE: the one-line collapse marker for `count` suppressed repeats of `line` (no stamp on `line`). */
export function formatRepeatLine(line, count, sinceMs, nowMs = Date.now()) {
  return `${new Date(nowMs).toISOString()} (repeated ${count} times since ${new Date(sinceMs).toISOString()}) ${line}`;
}

/**
 * PURE: replay collapsed repeat lines so line-counting parsers see every occurrence. Takes and returns a string
 * (newline separated). Lines that are not repeat markers pass through byte-for-byte; a log with no markers is
 * returned unchanged.
 * @param {string} text
 */
export function expandRepeatedLines(text) {
  const s = String(text ?? '');
  if (!s.includes('(repeated ')) return s;
  const lines = s.split('\n');
  const out = [];
  let budget = MAX_TOTAL_EXPANSION;
  for (let i = 0; i < lines.length;) {
    if (!REPEAT_LINE_RE.test(lines[i])) { out.push(lines[i]); i += 1; continue; }
    // Back-to-back markers are one flush of an interleaved cycle (tick line, detail line, tick line, ...): replay
    // them round-robin so the original order — and so each detail's tick — survives. Beyond the shared budget a
    // marker is left as the single line it is.
    const group = [];
    for (; i < lines.length; i += 1) {
      const m = REPEAT_LINE_RE.exec(lines[i]);
      if (!m) break;
      const n = Math.min(Number(m[2]), MAX_EXPANSION);
      if (n > budget) { group.push({ left: 0, raw: lines[i] }); continue; }
      budget -= n;
      group.push({ left: n, text: m[1] ? `${m[1]} ${m[3]}` : m[3] });
    }
    for (const g of group) if (g.raw !== undefined) out.push(g.raw);
    for (let more = true; more;) {
      more = false;
      for (const g of group) if (g.left > 0) { out.push(g.text); g.left -= 1; more = true; }
    }
  }
  return out.join('\n');
}
