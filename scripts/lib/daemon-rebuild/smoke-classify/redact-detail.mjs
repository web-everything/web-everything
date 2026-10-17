/** @file scripts/lib/daemon-rebuild/smoke-classify/redact-detail.mjs — the alert-safe form of a failed check's
 * detail, shared by the classifiers and the smoke-and-adopt ladder. Split out of daemon-rebuild.mjs (move-only).
 */

/** Secret shapes a child's stderr or a crash dump can echo: GitHub, Anthropic, npm and Slack tokens, AWS key ids, auth headers. */
const SECRET_PATTERNS = [
  [/\b(gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g, '$1<redacted>'],
  [/\b(sk-ant-)[A-Za-z0-9_-]+/g, '$1<redacted>'],
  [/\b(npm_)[A-Za-z0-9]{20,}/g, '$1<redacted>'],
  [/\b(xox[abposr]-)[A-Za-z0-9-]+/g, '$1<redacted>'],
  [/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA<redacted>'],
  [/\b(Bearer|Basic|token)(\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1$2<redacted>'],
  [/\b(authorization|api[_-]?key|password|secret)(["']?\s*[:=]\s*["']?)[^\s"',;]+/gi, '$1$2<redacted>'],
];
const MAX_LINE = 500;
const MAX_BOOT_DETAIL = 16_000;

/** Every known secret shape redacted, and each line capped, so a stderr tail is safe to persist. */
export function redactSecrets(text) {
  let out = String(text ?? '');
  for (const [re, to] of SECRET_PATTERNS) out = out.replace(re, to);
  return out.split('\n').map((line) => (line.length > MAX_LINE ? `${line.slice(0, MAX_LINE - 1)}…` : line)).join('\n');
}

/** Boot diagnostics keep their stderr tails, bounded to the head (which names the failed entries) plus the newest
 *  lines; every other detail is one 500-char line. */
export function redactDetail(detail, checkName) {
  const text = redactSecrets(detail);
  if (checkName !== 'daemon-entries-boot') return text.slice(0, 500);
  return text.length > MAX_BOOT_DETAIL ? `${text.slice(0, 2_000)}\n…\n${text.slice(-(MAX_BOOT_DETAIL - 2_003))}` : text;
}
