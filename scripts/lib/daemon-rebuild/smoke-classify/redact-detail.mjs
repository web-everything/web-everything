/** @file scripts/lib/daemon-rebuild/smoke-classify/redact-detail.mjs — the alert-safe form of a failed check's
 * detail, shared by the classifiers and the smoke-and-adopt ladder. Split out of daemon-rebuild.mjs (move-only).
 */

/** The boot check and the dispatch smoke details are allow-listed summaries (typed fields, the error class, the 0600
 *  stderr file's path — `daemon-boot-smoke.mjs`), so they keep every field (and every boot entry) instead of one
 *  500-char line that could cut the file path off. */
const SUMMARY_DETAILS = new Set(['daemon-entries-boot', 'dispatch-smoke']);
const SUMMARY_DETAIL_MAX = 4_000;

/** A failed check's detail, safe for the alerts log: tokens redacted, bounded (500 chars; a summary detail 4,000). */
export function redactDetail(detail, checkName) {
  return String(detail ?? '').replace(/\b(gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g, '$1<redacted>')
    .slice(0, SUMMARY_DETAILS.has(checkName) ? SUMMARY_DETAIL_MAX : 500);
}

/** First-line diagnostic for operator alerts: no host paths, tokens or terminal controls. */
export function redactDiagnosticLine(value) {
  return redactDetail(String(value ?? '').split(/[\r\n\u2028\u2029]/, 1)[0]
    .replace(/(?:[A-Za-z]:[\\/]|\/)[^\s'"<>]*/g, '<path>')
    .replace(/[\x00-\x1f\x7f-\x9f]/g, '')).slice(0, 300);
}
