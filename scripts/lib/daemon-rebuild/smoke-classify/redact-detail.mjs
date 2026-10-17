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
  return redactAssignments(line
    .replace(/(\/\/)[^/\s@]+@/g, '$1<redacted>@')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|glpat-[A-Za-z0-9_-]{16,}|npm_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{20,}|(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*)/g,
      (m) => `${m.match(/^(?:gh[pousr]_|github_pat_|glpat-|npm_|sk-ant-|sk-|AKIA|xox[baprs]-|AIza|eyJ)/)?.[0] ?? ''}<redacted>`)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 <redacted>'));
}

// A whole word (one start per word, so a long line costs linear time) followed by its separator: `name=`, `name:`,
// `"name": `, or `--name ` (a flag's value follows whitespace).
const NAME_SEP = /(?<![A-Za-z0-9_-])(["']?)(--?)?([A-Za-z0-9_][A-Za-z0-9_-]*)\1(\s*[=:]\s*|\s+)/g;
// A quoted value may hold spaces and escaped quotes.
const VALUE = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\S+/y;
// A secret word, or a generic key name (`KEY`, `*_KEY`, `*-key`, `PRIVATEKEY`, camelCase `serviceKey`) — never a
// word that merely contains "key" (`monkey`, `keyboard`).
const SECRET_NAME = /token|secret|password|passwd|api[_-]?key|auth|credential|(?:private|access|ssh|pass|signing|encryption|master)key|(?:^|[^A-Za-z])key(?![a-z])/i;
const CAMEL_KEY = /[a-z0-9]Key(?![a-z])/;

/** Redact each `name=value` / `name: value` / `--name value` whose name is a secret name. A plain name never consumes
 *  its value, so `monkey: token=…` still reaches the `token=` pair. */
function redactAssignments(line) {
  let out = '';
  let from = 0;
  NAME_SEP.lastIndex = 0;
  for (let m = NAME_SEP.exec(line); m; m = NAME_SEP.exec(line)) {
    const [whole, , dashes = '', name, sep] = m;
    const secret = (SECRET_NAME.test(name) || CAMEL_KEY.test(name)) && (dashes || /[=:]/.test(sep));
    if (!secret) continue;
    VALUE.lastIndex = m.index + whole.length;
    const value = VALUE.exec(line);
    if (!value) continue;
    out += `${line.slice(from, m.index)}${dashes}${name}=<redacted>`;
    from = VALUE.lastIndex;
    NAME_SEP.lastIndex = from;
  }
  return out + line.slice(from);
}

const ORPHAN_END = /-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/;
const B64 = /[A-Za-z0-9+/=]/;
// A body line, bare or indented, quoted, `\n`-escaped or `+`-joined (Node's inspect form); the last may be short.
// The trailing `+` (a joined string) is a single optional char, so it never competes with the body's own `+` run.
const BODY_LINE = /^\s*['"`]?[A-Za-z0-9+/=]{16,}(?:\\n)?['"`]?[\s,]*(?:\+[\s,]*)?$/;
const LAST_BODY_LINE = /^\s*['"`]?[A-Za-z0-9+/=]+(?:\\n)?['"`]?[\s,]*(?:\+[\s,]*)?$/;
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

// Text is redacted whole and only then cut: a cut first could split a quoted value and leave its tail unredacted.
// Redaction work is linear but not free, so input past these bounds is withheld (fail closed), never cut first.
const MAX_REDACT_LINE = 256 * 1024;
const MAX_REDACT_INPUT = 1024 * 1024;
const TAIL_WINDOW = 64 * 1024;
const WITHHELD = '<detail withheld: redaction could not run>';
const BREAK = new RegExp(`[\\n\\r${String.fromCharCode(0x85, 0x2028, 0x2029)}]`);

/** The index of the last line break in `text` before `end`, scanning no further back than `floor`; -1 when none. */
function lastBreakBefore(text, end, floor) {
  for (let i = end - 1; i >= floor; i--) if (BREAK.test(text[i])) return i;
  return -1;
}

/**
 * Untrusted text (a child's stderr, a worker-written field) made safe to persist: line breaks normalised, control
 * characters dropped, PEM private keys and secret shapes redacted, and only THEN each line capped at 500 chars. Fails
 * closed: a line or an input too long to redact is withheld, and a redaction that throws emits no detail at all.
 */
export function redactSecrets(text) {
  try {
    const raw = String(text ?? '');
    if (raw.length > MAX_REDACT_INPUT) return `<detail withheld: ${raw.length} chars exceeds the redaction bound>`;
    // NFKC folds fullwidth letters and invisible characters are dropped, so a fullwidth or zero-width-split `TOKEN=`
    // still matches. NFKC can grow text many times over, so the bound is checked again on its result.
    const source = raw.normalize('NFKC');
    if (source.length > MAX_REDACT_INPUT) return `<detail withheld: ${source.length} chars exceeds the redaction bound>`;
    const normalised = redactOrphanedKeys(source.replace(LINE_BREAKS, '\n').replace(CONTROLS, '').replace(INVISIBLE, '')
      .replace(/-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----|$)/g, '<redacted private key>'));
    return normalised.split('\n').map((raw) => {
      if (raw.length > MAX_REDACT_LINE) return `<line withheld: ${raw.length} chars is too long to redact>`;
      const line = redactLine(raw);
      return line.length > MAX_LINE ? `${line.slice(0, MAX_LINE - 1)}…` : line;
    }).join('\n');
  } catch {
    return WITHHELD;
  }
}

/**
 * The newest `lines` lines of untrusted output, made safe: bounded to whole lines near its last 64 KiB, redacted, and
 * only THEN cut to `lines`. A window that starts inside a line drops that partial line; when the whole window is the
 * tail of one line, that line is redacted from its start (or withheld when too long), never from a mid-line cut.
 */
export function redactedTail(text, lines = 30) {
  try {
    let raw = String(text ?? '');
    if (raw.length > TAIL_WINDOW) {
      const start = raw.length - TAIL_WINDOW;
      const after = raw.slice(start).search(BREAK);
      if (after >= 0) raw = raw.slice(start + after + 1);
      else if (raw.length > MAX_REDACT_LINE) {
        const begin = lastBreakBefore(raw, start, raw.length - MAX_REDACT_LINE);
        if (begin < 0) return `<line withheld: the last line is longer than ${MAX_REDACT_LINE} chars and too long to redact>`;
        raw = raw.slice(begin + 1);
      }
    }
    return redactSecrets(raw).trimEnd().split('\n').slice(-lines).join('\n');
  } catch {
    return WITHHELD;
  }
}

/** Boot diagnostics keep their stderr tails (the check itself budgets each failed entry; this is the backstop:
 *  head plus newest lines, 16 KB); every other detail is one 500-char line, redacted from whole lines first. */
export function redactDetail(detail, checkName) {
  try {
    if (checkName !== 'daemon-entries-boot') {
      const text = String(detail ?? '');
      // Only the first 500 chars survive, so redact the whole lines within the first 8,000 (or the first line).
      let head = text;
      if (text.length > 8_000) {
        const b = lastBreakBefore(text, 8_001, 0);
        const first = text.search(BREAK);
        head = b >= 0 ? text.slice(0, b) : first >= 0 ? text.slice(0, first) : text;
      }
      return redactSecrets(head).slice(0, 500);
    }
    const text = redactSecrets(detail);
    return text.length > MAX_BOOT_DETAIL ? `${text.slice(0, 2_000)}\n…\n${text.slice(-(MAX_BOOT_DETAIL - 2_003))}` : text;
  } catch {
    return WITHHELD;
  }
}
