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
 * Every known token shape redacted — the shapes of `ci-heal-mark.mjs#redactSecrets` (tokens, keys, JWTs, auth
 * headers, URL credentials), kept here so the daemon smoke path does not import the conveyor's comment module. None
 * spans a line. `name=value` pairs are {@link redactAssignments}' job.
 */
function redactShapes(text) {
  return text
    .replace(/(\/\/)[^/\s@]+@/g, '$1<redacted>@')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|glpat-[A-Za-z0-9_-]{16,}|npm_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{20,}|(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*)/g,
      (m) => `${m.match(/^(?:gh[pousr]_|github_pat_|glpat-|npm_|sk-ant-|sk-|AKIA|xox[baprs]-|AIza|eyJ)/)?.[0] ?? ''}<redacted>`)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 <redacted>');
}

// A whole word (one start per word, so a long text costs linear time) followed by its separator on the same line:
// `name=`, `name:`, `"name": `, or `--name ` (a flag's value follows whitespace).
const NAME_SEP = /(?<![A-Za-z0-9_-])(["']?)(--?)?([A-Za-z0-9_][A-Za-z0-9_-]*)\1([^\S\n]*[=:][^\S\n]*|[^\S\n]+)/g;
// A secret word, or a generic key name (`KEY`, `*_KEY`, `*-key`, `PRIVATEKEY`, camelCase `serviceKey`) — never a
// word that merely contains "key" (`monkey`, `keyboard`).
const SECRET_NAME = /token|secret|password|passwd|api[_-]?key|auth|credential|(?:private|access|ssh|pass|signing|encryption|master)key|(?:^|[^A-Za-z])key(?![a-z])/i;
const CAMEL_KEY = /[a-z0-9]Key(?![a-z])/;

// A value may span lines: a quoted string (longest delimiter first, so `"""` is never read as an empty `""`), parts
// joined by `+` (Node's inspect form), a YAML block or next-line scalar, or a backslash-continued bare word.
const QUOTES = ['"""', "'''", '"', "'", '`'];
// A quoted value still open after this many lines is read as unterminated: everything after its quote is redacted.
const MAX_VALUE_LINES = 64;
const JOIN = /\s*\+\s*/y;
const BLOCK_INDICATOR = /[|>][1-9+-]{0,2}[^\S\n]*(?:#[^\n]*)?(?=\n|$)/y;
const BARE = /\S+/y;
const CONTINUED = /[^\S\n]*\S*/y;
const isBlank = (c) => c === ' ' || c === '\t';

/** The end of a `q`-quoted value whose body starts at `from` (just past the quote), or -1 when it does not close
 *  within {@link MAX_VALUE_LINES} lines. Linear in the span scanned. */
function quotedEnd(text, from, q) {
  let lines = 0;
  for (let i = from; i < text.length; i++) {
    if (text[i] === '\\') {
      // An escaped character never closes the value; an escaped line break still counts toward the bound.
      i++;
      if (text[i] === '\n' && ++lines > MAX_VALUE_LINES) return -1;
    } else if (text[i] === '\n') {
      if (++lines > MAX_VALUE_LINES) return -1;
    } else if (text.startsWith(q, i)) {
      return i + q.length;
    }
  }
  return -1;
}

/** Past a quoted value ending at `end`, every further quoted part joined to it by `+`; an unterminated part runs to
 *  the end of the text. */
function joinedEnd(text, end) {
  for (;;) {
    JOIN.lastIndex = end;
    if (!JOIN.exec(text)) return end;
    const at = JOIN.lastIndex;
    const q = QUOTES.find((d) => text.startsWith(d, at));
    if (!q) return end;
    const next = quotedEnd(text, at + q.length, q);
    if (next < 0) return text.length;
    end = next;
  }
}

/** The lines after the one ending at `eol` that are indented deeper than `indent` (blank lines between them
 *  included), at most `max` of them; -1 when there are none. */
function indentedEnd(text, eol, indent, max = Infinity) {
  let end = -1;
  for (let at = eol, n = 0; at < text.length && n < max; n++) {
    const start = at + 1;
    let k = start;
    while (k < text.length && isBlank(text[k])) k++;
    const next = text.indexOf('\n', start);
    const lineEnd = next < 0 ? text.length : next;
    if (k < lineEnd) {
      if (k - start <= indent) break;
      end = lineEnd;
    }
    at = lineEnd;
  }
  return end;
}

/** Where the value of the secret pair whose name starts at `nameAt` and whose value starts at `at` ends, or -1 when
 *  it has none. Fails closed: an unterminated quoted value runs to the end of the text. */
function valueEnd(text, nameAt, at) {
  const q = QUOTES.find((d) => text.startsWith(d, at));
  if (q) {
    const end = quotedEnd(text, at + q.length, q);
    return end < 0 ? text.length : joinedEnd(text, end);
  }
  BLOCK_INDICATOR.lastIndex = at;
  const block = BLOCK_INDICATOR.test(text);
  if (block || at >= text.length || text[at] === '\n') {
    // YAML: a block scalar (`|`, `>`) is every deeper-indented line below; a bare `name:` takes the next one.
    const eol = block ? BLOCK_INDICATOR.lastIndex : at;
    const lineStart = text.lastIndexOf('\n', nameAt - 1) + 1;
    let indent = 0;
    while (isBlank(text[lineStart + indent])) indent++;
    const end = indentedEnd(text, eol, indent, block ? Infinity : 1);
    return end < 0 ? (block ? eol : -1) : end;
  }
  BARE.lastIndex = at;
  if (!BARE.exec(text)) return -1;
  let end = BARE.lastIndex;
  // A shell line continuation: the word goes on at the start of the next line.
  while (text[end - 1] === '\\' && text[end] === '\n') {
    CONTINUED.lastIndex = end + 1;
    CONTINUED.exec(text);
    end = CONTINUED.lastIndex;
  }
  return end;
}

/** Each `name=value` / `name: value` / `--name value` span from `from` on whose name is a secret name, as
 *  `{start, end, label}`. The text is scanned whole, so a value that spans lines is redacted whole. A plain name never
 *  consumes its value, so `monkey: token=…` still reaches the `token=` pair. */
function assignmentSpans(text, from = 0) {
  const spans = [];
  NAME_SEP.lastIndex = from;
  for (let m = NAME_SEP.exec(text); m; m = NAME_SEP.exec(text)) {
    const [whole, , dashes = '', name, sep] = m;
    const secret = (SECRET_NAME.test(name) || CAMEL_KEY.test(name)) && (dashes || /[=:]/.test(sep));
    if (!secret) continue;
    const end = valueEnd(text, m.index, m.index + whole.length);
    if (end < 0) continue;
    spans.push({ start: m.index, end, label: `${dashes}${name}=<redacted>` });
    NAME_SEP.lastIndex = end;
  }
  return spans;
}

/**
 * Where the value a cut-open text may START inside could end, one per reading: inside a quoted string (each
 * delimiter), a quoted part joined by `+`, deeper-indented YAML lines, or a backslash-continued line (the first line
 * itself, at least). A quoted reading whose quote does not close within {@link MAX_VALUE_LINES} lines is dropped:
 * the same bound reads such a value as unterminated where its opening quote is seen. Known limit: a quoted value of
 * more than that many lines whose opening quote was cut off is not caught here — reading every quote-free cut text
 * as secret would drop every cut tail whole.
 */
function cutOpenEnds(text) {
  const ends = [];
  for (const q of QUOTES) {
    const end = quotedEnd(text, 0, q);
    if (end >= 0) ends.push(joinedEnd(text, end));
  }
  const lead = /^\s*\+?\s*/.exec(text)[0].length;
  const q = QUOTES.find((d) => text.startsWith(d, lead));
  if (q) {
    const end = quotedEnd(text, lead + q.length, q);
    if (end >= 0) ends.push(joinedEnd(text, end));
  }
  ends.push(indentedEnd(text, -1, 0));
  let eol = text.indexOf('\n');
  while (eol > 0 && text[eol - 1] === '\\') eol = text.indexOf('\n', eol + 1);
  ends.push(eol < 0 ? text.length : eol);
  return ends.filter((end) => end > 0);
}

/**
 * Every secret pair in `text` redacted, the text scanned whole. With `cut`, the text starts at a cut and may start
 * inside a value whose name was cut off: each reading of where that value ends ({@link cutOpenEnds}) is redacted,
 * and the pairs are found both as if the text started clean and as if it resumed after each such end — so a quote
 * that might close the cut-off value, or might open a new one, is safe either way.
 */
function redactAssignments(text, cut) {
  const spans = assignmentSpans(text);
  if (cut && text) {
    for (const end of cutOpenEnds(text)) {
      spans.push({ start: 0, end, label: '<redacted>' }, ...assignmentSpans(text, end));
    }
    spans.sort((a, b) => a.start - b.start || b.end - a.end);
  }
  let out = '';
  let from = 0;
  for (const s of spans) {
    // An overlapping span (a second reading of the same stretch) widens the redaction already emitted.
    if (s.start < from) { from = Math.max(from, s.end); continue; }
    out += `${text.slice(from, s.start)}${s.label}`;
    from = s.end;
  }
  return out + text.slice(from);
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

/** The first line of a text whose start was cut off (a file read from mid-file, a compacted stderr file): the text
 *  after it may start inside a value whose name was cut off, so {@link redactedTail} redacts it as cut. */
export const CUT_MARKER = '<earlier output cut>';

/**
 * Untrusted text (a child's stderr, a worker-written field) made safe to persist: line breaks normalised, control
 * characters dropped, PEM private keys and secret shapes redacted over the WHOLE text (a quoted value may span lines),
 * and only THEN split into lines, each capped at 500 chars. With `cut`, the text starts at a cut and may start inside
 * a value (see {@link redactAssignments}). Fails closed: a line or an input too long to redact is withheld, and a
 * redaction that throws emits no detail at all.
 */
export function redactSecrets(text, { cut = false } = {}) {
  try {
    const raw = String(text ?? '');
    if (raw.length > MAX_REDACT_INPUT) return `<detail withheld: ${raw.length} chars exceeds the redaction bound>`;
    // NFKC folds fullwidth letters and invisible characters are dropped, so a fullwidth or zero-width-split `TOKEN=`
    // still matches. NFKC can grow text many times over, so the bound is checked again on its result.
    const source = raw.normalize('NFKC');
    if (source.length > MAX_REDACT_INPUT) return `<detail withheld: ${source.length} chars exceeds the redaction bound>`;
    const normalised = redactOrphanedKeys(source.replace(LINE_BREAKS, '\n').replace(CONTROLS, '').replace(INVISIBLE, '')
      .replace(/-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----|$)/g, '<redacted private key>'));
    // Redacted whole, THEN split: a split first would leave every line after a multiline value's first unredacted.
    return redactAssignments(redactShapes(normalised), cut).split('\n').map((line) => {
      if (line.length > MAX_REDACT_LINE) return `<line withheld: ${line.length} chars is too long to redact>`;
      return line.length > MAX_LINE ? `${line.slice(0, MAX_LINE - 1)}…` : line;
    }).join('\n');
  } catch {
    return WITHHELD;
  }
}

/**
 * The newest `lines` lines of untrusted output, made safe: bounded to whole lines near its last 64 KiB, redacted, and
 * only THEN cut to `lines`. A window that starts inside a line drops that partial line; when the whole window is the
 * tail of one line, that line is redacted from its start (or withheld when too long), never from a mid-line cut. A
 * window, or a text that opens with {@link CUT_MARKER}, starts at a cut and is redacted as one (it may start inside a
 * multiline value).
 */
export function redactedTail(text, lines = 30) {
  try {
    let raw = String(text ?? '');
    let cut = raw.startsWith(`${CUT_MARKER}\n`);
    if (cut) raw = raw.slice(CUT_MARKER.length + 1);
    if (raw.length > TAIL_WINDOW) {
      const start = raw.length - TAIL_WINDOW;
      const after = raw.slice(start).search(BREAK);
      if (after >= 0) {
        raw = raw.slice(start + after + 1);
        cut = true;
      } else if (raw.length > MAX_REDACT_LINE) {
        const begin = lastBreakBefore(raw, start, raw.length - MAX_REDACT_LINE);
        if (begin < 0) return `<line withheld: the last line is longer than ${MAX_REDACT_LINE} chars and too long to redact>`;
        raw = raw.slice(begin + 1);
        cut = true;
      }
    }
    return redactSecrets(raw, { cut }).trimEnd().split('\n').slice(-lines).join('\n');
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
