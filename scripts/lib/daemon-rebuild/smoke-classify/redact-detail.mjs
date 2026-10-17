/** @file scripts/lib/daemon-rebuild/smoke-classify/redact-detail.mjs — the alert-safe form of a failed check's
 * detail, shared by the classifiers and the smoke-and-adopt ladder. Split out of daemon-rebuild.mjs (move-only).
 */

/** The boot check's detail is an allow-listed summary (one line per failed entry: typed fields, the error class, the
 *  0600 stderr file's path — `daemon-boot-smoke.mjs`), so it keeps every entry instead of one 500-char line. */
const BOOT_DETAIL_MAX = 4_000;

/** A failed check's detail, safe for the alerts log: tokens redacted, bounded (500 chars; the boot summary 4,000). */
export function redactDetail(detail, checkName) {
  return String(detail ?? '').replace(/\b(gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g, '$1<redacted>')
    .slice(0, checkName === 'daemon-entries-boot' ? BOOT_DETAIL_MAX : 500);
}
