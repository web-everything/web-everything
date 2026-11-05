/**
 * The real stderr of a failed `gh` call, for error details. `execFileSync` puts only "Command failed: <argv>" in
 * `err.message`, which hides the cause (auth, permission, validation). Returns the LAST `max` chars of `err.stderr`
 * with secrets redacted (redact first, then cut), or '' when there is none.
 */
import { redactSecrets } from '../conveyor/ci-heal-mark.mjs';

export function ghStderrTail(err, max = 800) {
  const raw = err?.stderr;
  if (raw == null) return '';
  const text = redactSecrets(String(raw)).trim();
  return text.length > max ? text.slice(-max) : text;
}
