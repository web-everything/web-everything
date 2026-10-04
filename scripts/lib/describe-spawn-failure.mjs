/**
 * @file describe-spawn-failure.mjs — turn a failed child-process spawn (`execFileSync`'s thrown error) into ONE
 * log-safe line that names the REAL cause.
 *
 * WHY. `execFileSync` builds `error.message` as `Command failed: <full argv>\n<stderr>`. The fix daemon logged
 * only `message.split('\n')[0]`, i.e. the argv alone: for `claude --bg` that is the `--settings` JSON (with the
 * worker env) plus the first line of the brief — and never the exit code or stderr, so a failed dispatch
 * ("refused dispatch-failed … PR #3794 — Command failed: claude --bg -n fix-3794 …") could not be diagnosed.
 *
 * WHAT IT RETURNS: `<label> failed (exit N | signal S | code C): <stderr tail>` — one line, no argv, no brief,
 * no `--settings` JSON, token-shaped strings redacted. The stderr text is kept verbatim (after redaction) so
 * the daemon-log parsers that match CLI phrases (e.g. `Workspace not trusted`) still see it. PURE.
 */

const REDACTIONS = [
  [/--settings\s+\{.*?\}\}?/gs, '--settings <redacted>'],
  [/"(?:PATH|GH_TOKEN|GITHUB_TOKEN|[A-Z_]*(?:TOKEN|SECRET|KEY|PASSWORD)[A-Z_]*)"\s*:\s*"[^"]*"/g, '"<redacted-env>"'],
  [/\b(?:gh[posru]_|github_pat_)[A-Za-z0-9_]{8,}/g, '<redacted-token>'],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, '<redacted-token>'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer <redacted>'],
  [/\b(?:token|secret|password|api[_-]?key)\s*[:=]\s*\S+/gi, 'credential=<redacted>'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}/g, '<redacted-jwt>'],
];

/** Redact token-shaped strings and any `--settings {…}` JSON from free text. PURE. */
export function redactSpawnText(text) {
  let out = String(text ?? '');
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
  return out;
}

/**
 * @param {unknown} error - what the spawn threw.
 * @param {{label?: string, maxChars?: number}} [opts]
 * @returns {string} one line.
 */
export function describeSpawnFailure(error, { label = 'spawn', maxChars = 600 } = {}) {
  const e = error && typeof error === 'object' ? error : { message: String(error ?? '') };
  const how = [];
  if (Number.isInteger(e.status)) how.push(`exit ${e.status}`);
  if (e.signal) how.push(`signal ${e.signal}`);
  if (e.code != null && !Number.isInteger(e.status)) how.push(`code ${String(e.code)}`);
  const stderr = String(e.stderr ?? '').trim();
  const stdout = String(e.stdout ?? '').trim();
  // Never fall back to `message` when it is the `Command failed: <argv>` form — the argv carries the brief.
  const message = String(e.message ?? '');
  const fallback = /^Command failed:/.test(message) ? '' : message;
  const text = stderr || stdout || fallback || 'no output';
  const flat = redactSpawnText(text).replace(/\s*\n\s*/g, ' | ').trim();
  const tail = flat.length > maxChars ? `…${flat.slice(-maxChars)}` : flat;
  return `${label} failed (${how.join(', ') || 'no exit status'}): ${tail}`;
}

/**
 * The `why` of a `dispatch-failed` refusal. A failed spawn (an `execFileSync` error carrying
 * `status`/`stderr`/`signal`) is described by its exit code + redacted stderr tail; any other error keeps its
 * first message line (the old behaviour, which for a spawn error logged only the argv and hid the cause).
 *
 * @param {unknown} e
 * @param {string} [label]
 * @returns {string}
 */
export function describeDispatchFailure(e, label = 'claude --bg') {
  if (e && typeof e === 'object' && ('stderr' in e || 'status' in e || 'signal' in e)) {
    return describeSpawnFailure(e, { label });
  }
  return String((e && e.message) || e).split('\n')[0];
}
