/** @file scripts/lib/daemon-rebuild/smoke-classify/redact-detail.mjs — the alert-safe form of a failed check's
 * detail, shared by the classifiers and the smoke-and-adopt ladder. Split out of daemon-rebuild.mjs (move-only).
 */

const MAX_LINE = 500;
const MAX_BOOT_DETAIL = 16_000;
// CR, U+0085, U+2028 and U+2029 end a line; every other control character (but tab and newline) is dropped.
const LINE_BREAKS = new RegExp(`\\r\\n?|[${String.fromCharCode(0x85, 0x2028, 0x2029)}]`, 'g');
const CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u0084\u0086-\u009f]/g;
// Soft hyphen, zero-width and direction marks, word joiners and the BOM — built from code points, never written raw.
const INVISIBLE = new RegExp(`[${String.fromCharCode(0xad)}${String.fromCharCode(0x200b)}-${String.fromCharCode(0x200f)}${String.fromCharCode(0x202a)}-${String.fromCharCode(0x202e)}${String.fromCharCode(0x2060)}-${String.fromCharCode(0x2064)}${String.fromCharCode(0xfeff)}]`, 'g');

/**
 * One line with every known secret shape redacted — the shapes of `ci-heal-mark.mjs#redactSecrets` (tokens, keys,
 * JWTs, auth headers, PEM keys, URL credentials, `*_TOKEN=`/`*password:` style pairs) plus generic `*_KEY=` names,
 * kept here so the daemon smoke path does not import the conveyor's comment module. The key run is bounded (no
 * quadratic scan).
 */
function redactLine(line) {
  return line
    .replace(/(\/\/)[^/\s@]+@/g, '$1<redacted>@')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|glpat-[A-Za-z0-9_-]{16,}|npm_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{20,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*)/g,
      (m) => `${m.match(/^(?:gh[pousr]_|github_pat_|glpat-|npm_|sk-ant-|sk-|AKIA|xox[baprs]-|AIza|eyJ)/)?.[0] ?? ''}<redacted>`)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 <redacted>')
    // `name=value` / `name: value` / `"name": "value"`, then `--name value`, then camelCase `serviceKey: value`. Only a
    // secret name can match at all, so no match on a plain word (`monkey: token=…`) swallows the pair after it.
    .replace(ASSIGNMENT, (_m, _q, dashes, key) => `${dashes ?? ''}${key}=<redacted>`)
    .replace(FLAG, (_m, _q, dashes, key) => `${dashes}${key}=<redacted>`)
    .replace(CAMEL_ASSIGNMENT, (_m, _q, key) => `${key}=<redacted>`);
}

// A secret word, or a generic key name (`KEY`, `*_KEY`, `*-key`, `PRIVATEKEY`) — never a word that merely contains
// "key" (`monkey`, `keyboard`).
const KEY_WORD = 'token|secret|password|passwd|api[_-]?key|auth|credential|[_-]?(?<![A-Za-z])key(?![a-z])|(?:private|access|ssh|pass|signing|encryption|master)key';
const KEY_NAME = `[A-Za-z0-9_]{0,48}(?:${KEY_WORD})[A-Za-z0-9_-]{0,48}`;
// A quoted value may hold spaces and escaped quotes.
const VALUE = `("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|\\S+)`;
const ASSIGNMENT = new RegExp(`(["']?)(--?)?(${KEY_NAME})\\1(\\s*[=:]\\s*)${VALUE}`, 'gi');
const FLAG = new RegExp(`(["']?)(--?)(${KEY_NAME})\\1\\s+${VALUE}`, 'gi');
const CAMEL_ASSIGNMENT = new RegExp(`(["']?)([A-Za-z0-9_]{0,48}[a-z0-9]Key)\\1\\s*[=:]\\s*${VALUE}`, 'g');

const ORPHAN_END = /-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/;
const B64 = /[A-Za-z0-9+/=]/;
// A body line, bare or indented, quoted, `\n`-escaped or `+`-joined (Node's inspect form); the last may be short.
const BODY_LINE = /^\s*['"`]?[A-Za-z0-9+/=]{16,}(?:\\n)?['"`]?[\s+,]*$/;
const LAST_BODY_LINE = /^\s*['"`]?[A-Za-z0-9+/=]+(?:\\n)?['"`]?[\s+,]*$/;
/** Where a `\n`-escaped body (JSON) that runs up to `end` on the same line starts. Linear: one backward walk. */
function escapedBodyStart(line, end) {
  let i = end;
  while (line.endsWith('\\n', i)) {
    let k = i - 2;
    while (k > 0 && B64.test(line[k - 1]) && !(line[k - 1] === 'n' && line[k - 2] === '\\')) k--;
    if (k === i - 2) break;
    i = k;
  }
  return i;
}
/** A key whose BEGIN line was cut off upstream: drop its body lines right above the orphaned END line, and a body
 *  escaped onto the END line itself, with no count cap, so a long key is never partly kept. Linear: each line is
 *  dropped at most once. */
function redactOrphanedKeys(text) {
  if (!text.includes('PRIVATE KEY')) return text;
  const out = [];
  for (const line of text.split('\n')) {
    const at = line.search(ORPHAN_END);
    if (at < 0) { out.push(line); continue; }
    if (out.length && LAST_BODY_LINE.test(out[out.length - 1])) out.pop();
    while (out.length && BODY_LINE.test(out[out.length - 1])) out.pop();
    const start = escapedBodyStart(line, at);
    out.push(`${line.slice(0, start)}${line.slice(at).replace(new RegExp(ORPHAN_END.source, 'g'), '<redacted private key>')}`);
  }
  return out.join('\n');
}

/**
 * Untrusted text (a child's stderr, a worker-written field) made safe to persist: line breaks normalised, control
 * characters dropped, PEM private keys and secret shapes redacted, each line capped at 500 chars. Each line is cut to
 * 4x the cap BEFORE redaction (bounding regex work) and to the cap after it, so a cut never slices a secret's prefix.
 */
export function redactSecrets(text) {
  // NFKC folds fullwidth letters and invisible characters are dropped, so a fullwidth or zero-width-split `TOKEN=`
  // still matches.
  const normalised = redactOrphanedKeys(String(text ?? '').normalize('NFKC').replace(LINE_BREAKS, '\n').replace(CONTROLS, '').replace(INVISIBLE, '')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----|$)/g, '<redacted private key>'));
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
