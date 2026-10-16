/** @file scripts/lib/daemon-rebuild/smoke-classify/redact-detail.mjs — the alert-safe form of a failed check's
 * detail, shared by the classifiers and the smoke-and-adopt ladder. Split out of daemon-rebuild.mjs (move-only).
 */

/** Keep native boot diagnostics (including stderr tails) while retaining token redaction. */
export function redactDetail(detail, checkName) {
  const text = String(detail ?? '').replace(/\b(gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g, '$1<redacted>');
  return checkName === 'daemon-entries-boot' ? text : text.slice(0, 500);
}
