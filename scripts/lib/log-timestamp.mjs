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
