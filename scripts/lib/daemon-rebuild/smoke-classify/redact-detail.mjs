/** @file scripts/lib/daemon-rebuild/smoke-classify/redact-detail.mjs — the alert-safe form of a failed check's
 * detail, shared by the classifiers and the smoke-and-adopt ladder. Split out of daemon-rebuild.mjs (move-only).
 */

const MAX_LINE = 500;
const MAX_BOOT_DETAIL = 16_000;
// CR, U+0085, U+2028 and U+2029 end a line; every other control character (but tab and newline) is dropped.
const LINE_BREAKS = new RegExp(`\\r\\n?|[${String.fromCharCode(0x85, 0x2028, 0x2029)}]`, 'g');
const CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u0084\u0086-\u009f]/g;

/**
 * One line with every known secret shape redacted — the same shapes as `ci-heal-mark.mjs#redactSecrets`
 * (tokens, keys, JWTs, auth headers, PEM keys, URL credentials, `*_TOKEN=`/`*password:` style pairs), kept here
 * so the daemon smoke path does not import the conveyor's comment module. The key run is bounded (no quadratic scan).
 */
function redactLine(line) {
  return line
    .replace(/(\/\/)[^/\s@]+@/g, '$1<redacted>@')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|glpat-[A-Za-z0-9_-]{16,}|npm_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{20,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*)/g,
      (m) => `${m.match(/^(?:gh[pousr]_|github_pat_|glpat-|npm_|sk-ant-|sk-|AKIA|xox[baprs]-|AIza|eyJ)/)?.[0] ?? ''}<redacted>`)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 <redacted>')
    // `name=value` / `name: value` / `"name": "value"`, then `--name value`. Two passes, so a declined match (a plain
    // word such as `monkey`) never swallows the `token=…` after it.
    .replace(ASSIGNMENT, (m, _q, dashes, key) => (isSecretKeyName(key) ? `${dashes ?? ''}${key}=<redacted>` : m))
    .replace(FLAG, (m, _q, dashes, key) => (isSecretKeyName(key) ? `${dashes}${key}=<redacted>` : m));
}

const KEY_NAME = '[A-Za-z0-9_]{0,48}(?:token|secret|password|passwd|api[_-]?key|[_-]?key|auth|credential)[A-Za-z0-9_-]{0,48}';
const VALUE = `("[^"]*"|'[^']*'|\\S+)`;
const ASSIGNMENT = new RegExp(`(["']?)(--?)?(${KEY_NAME})\\1(\\s*[=:]\\s*)${VALUE}`, 'gi');
const FLAG = new RegExp(`(["']?)(--?)(${KEY_NAME})\\1\\s+${VALUE}`, 'gi');
const SECRET_WORD = /token|secret|password|passwd|api[_-]?key|auth|credential/i;
/** A secret-keyword name, or a generic key name: `KEY`, `*_KEY`, `*-key`, camelCase `serviceKey` — never a word that
 *  merely ends in "key" (`monkey`, `hockey`). */
function isSecretKeyName(name) {
  return SECRET_WORD.test(name) || /(?:^|[^A-Za-z])key/i.test(name) || /[a-z0-9]Key/.test(name);
}

const ORPHAN_END = /-----END [A-Z ]*PRIVATE KEY-----/;
/** A key whose BEGIN line was cut off upstream: drop the base64 body lines right above its orphaned END line — the
 *  last body line may be short, earlier ones are 16+ chars — with no count cap, so a long key is never partly kept.
 *  Linear: each line is dropped at most once. */
function redactOrphanedKeys(text) {
  if (!text.includes('PRIVATE KEY-----')) return text;
  const out = [];
  for (const line of text.split('\n')) {
    if (!ORPHAN_END.test(line)) { out.push(line); continue; }
    if (out.length && /^[A-Za-z0-9+/=]+$/.test(out[out.length - 1])) out.pop();
    while (out.length && /^[A-Za-z0-9+/=]{16,}$/.test(out[out.length - 1])) out.pop();
    out.push(line.replace(new RegExp(ORPHAN_END.source, 'g'), '<redacted private key>'));
  }
  return out.join('\n');
}

/**
 * Untrusted text (a child's stderr, a worker-written field) made safe to persist: line breaks normalised, control
 * characters dropped, PEM private keys and secret shapes redacted, each line capped at 500 chars. Each line is cut to
 * 4x the cap BEFORE redaction (bounding regex work) and to the cap after it, so a cut never slices a secret's prefix.
 */
export function redactSecrets(text) {
  const normalised = redactOrphanedKeys(String(text ?? '').replace(LINE_BREAKS, '\n').replace(CONTROLS, '')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '<redacted private key>'));
  return normalised.split('\n').map((raw) => {
    const line = redactLine(raw.length > MAX_LINE * 4 ? raw.slice(0, MAX_LINE * 4) : raw);
    return line.length > MAX_LINE ? `${line.slice(0, MAX_LINE - 1)}…` : line;
  }).join('\n');
}

/**
 * The newest `lines` lines of untrusted output, made safe: bounded to its last 64 KiB (dropping the partial first
 * line), redacted, and only THEN cut to `lines` — so a cut never splits a secret or a CR run before redaction sees it.
 */
export function redactedTail(text, lines = 30) {
  let raw = String(text ?? '');
  if (raw.length > 64 * 1024) {
    raw = raw.slice(-64 * 1024);
    // Drop the partial first line only when a line break exists; a window with none is kept whole.
    const br = raw.search(/[\r\n]/);
    if (br >= 0) raw = raw.slice(br + 1);
  }
  return redactSecrets(raw).trimEnd().split('\n').slice(-lines).join('\n');
}

/** Boot diagnostics keep their stderr tails (the check itself budgets each failed entry; this is the backstop:
 *  head plus newest lines, 16 KB); every other detail is one 500-char line. */
export function redactDetail(detail, checkName) {
  if (checkName !== 'daemon-entries-boot') return redactSecrets(String(detail ?? '').slice(0, 8_000)).slice(0, 500);
  const text = redactSecrets(detail);
  return text.length > MAX_BOOT_DETAIL ? `${text.slice(0, 2_000)}\n…\n${text.slice(-(MAX_BOOT_DETAIL - 2_003))}` : text;
}
