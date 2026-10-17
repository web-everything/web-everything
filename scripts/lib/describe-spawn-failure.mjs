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
 * no `--settings` JSON, credentials redacted (see {@link redactSpawnText}). The stderr text is kept verbatim
 * (after redaction) so the daemon-log parsers that match CLI phrases (e.g. `Workspace not trusted`) still see
 * it. PURE, except that `redactSpawnText` reads `process.env` unless it is handed an `env`.
 */

// A credential's VALUE often has no recognisable shape (PR #5472 red team: an "opaque" env secret), so the
// structural rules below redact by POSITION — a whole `--settings` object, a whole `env` object, the value of
// any credential-named key — and the token-shape rules only catch what leaks outside those positions.
const CRED_TERM = /token|secret|passw(?:or)?d|api[_-]?key|private[_-]?key|access[_-]?key|auth(?!or)|credential|cookie|(?:^|[_.-])key(?:$|[_.-])/i;

/** Whether a key or variable name names a credential (or `PATH`, which carries the gh-shim directory). */
function isCredName(name) {
  return name === 'PATH' || CRED_TERM.test(name);
}

const JSON_STRING = String.raw`"(?:[^"\\]|\\.)*"`;
// Names are matched as ONE bounded identifier that starts where no identifier character precedes it, then
// tested by `isCredName` — so a long run of identifier characters is scanned once, never quadratically.
const IDENT = String.raw`(?<![A-Za-z0-9_.-])[A-Za-z0-9_.-]{1,128}`;
/**
 * A rule that redacts the value after every credential-named key. `nameRe` (global) matches `<name><separator>`
 * with the name in group 1; `valueRe` (sticky) is tried only after a credential name, so a non-credential
 * `failed: GH_TOKEN=x` neither swallows the `GH_TOKEN` after it nor rescans the rest of the text. A value that
 * is already `<redacted…>` is left as it is. `replacement` receives the name match.
 */
function namedValueRule(nameRe, valueRe, replacement) {
  return (text) => {
    let out = '';
    let from = 0;
    nameRe.lastIndex = 0;
    for (let m = nameRe.exec(text); m; m = nameRe.exec(text)) {
      const at = nameRe.lastIndex;
      if (!isCredName(m[1]) || text.startsWith('<redacted', at)) continue;
      valueRe.lastIndex = at;
      if (!valueRe.exec(text)) continue;
      out += text.slice(from, m.index) + replacement(m);
      from = valueRe.lastIndex;
      nameRe.lastIndex = from;
    }
    return out + text.slice(from);
  };
}

const TOKEN_SHAPES = [
  [/\b(?:gh[posru]_|github_pat_)[A-Za-z0-9_]{8,}/g, '<redacted-token>'],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, '<redacted-token>'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}/g, '<redacted-jwt>'],
];

const NAMED_VALUES = [
  // `"GH_TOKEN": "…"` (escaped quotes included) and the same inside JSON-encoded text (`\"GH_TOKEN\":\"…\"`).
  namedValueRule(/"([^"\\]{1,128})"\s*:\s*/g, new RegExp(String.raw`${JSON_STRING}|[^,}\s]+`, 'y'), () => '"<redacted-env>"'),
  namedValueRule(/\\"([^"\\]{1,128})\\"\s*:\s*/g, /\\"(?:[^"\\]|\\[^"])*\\"/y, () => '\\"<redacted-env>\\"'),
  [/\b((?:proxy-)?authorization)\s*:[^\r\n]*/gi, '$1: <redacted>'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer <redacted>'],
  // `GH_TOKEN=…`, `export X_API_KEY=…`, `password: …` — a value already redacted above is left as it is.
  namedValueRule(new RegExp(String.raw`(${IDENT})\s*[:=]\s*`, 'g'), new RegExp(String.raw`${JSON_STRING}|'[^']*'|\S+`, 'y'),
    (m) => `${m[0]}<redacted>`),
  [/(?<![a-z0-9+.-])([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/@:]{1,256}:[^\s/@]{1,256}@/gi, '$1<redacted>@'],
];

/** The end index (exclusive) of the balanced `{…}` starting at `open`, skipping JSON strings; `text.length`
 *  when it never closes, so an unterminated object is redacted to the end rather than leaked. A backslash
 *  outside a string (JSON-encoded JSON, `{\"a\":1}`) escapes the next character, so `\"` opens no string. */
function objectEnd(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '\\') i += 1;
    else if (ch === '"') {
      for (i += 1; i < text.length && text[i] !== '"'; i += text[i] === '\\' ? 2 : 1);
    } else if (ch === '{') depth += 1;
    else if (ch === '}' && --depth === 0) return i + 1;
  }
  return text.length;
}

/** Replace every object that follows `opener` (a global regex whose match ends just before `{`; group 1 is an
 *  optional opening quote to consume at the close). `replacement` receives the opener match. */
function redactObjects(text, opener, replacement) {
  let out = '';
  let from = 0;
  for (const m of text.matchAll(opener)) {
    const open = m.index + m[0].length;
    if (open < from) continue;
    let end = objectEnd(text, open);
    if (m[1] && text[end] === m[1]) end += 1; // the closing shell quote of `--settings '{…}'`
    out += text.slice(from, m.index) + replacement(m[0]);
    from = end;
  }
  return out + text.slice(from);
}

/** Literal values of this process's credential-named env vars, longest first (a value can contain another). */
function envSecretValues(env) {
  return Object.entries(env ?? {})
    .filter(([key, value]) => key !== 'PATH' && isCredName(key) && typeof value === 'string' && value.length >= 8)
    .map(([, value]) => value).sort((a, b) => b.length - a.length);
}

/**
 * Redact credentials from free text: any `--settings {…}` JSON, any `"env": {…}` object, the value of every
 * credential-named key (JSON, shell or header form), URL userinfo, token-shaped strings, and the literal value
 * of this process's own credential-named env vars. PURE but for the `env` default.
 * @param {unknown} text
 * @param {{env?: Record<string, string|undefined>}} [opts]
 */
export function redactSpawnText(text, { env = process.env } = {}) {
  let out = String(text ?? '');
  for (const value of envSecretValues(env)) out = out.split(value).join('<redacted-env>');
  out = redactObjects(out, /--settings(?:\s+|=)(['"]?)(?=\{)/g, () => '--settings <redacted>');
  out = redactObjects(out, /\\?"env\\?"\s*:\s*()(?=\{)/gi,
    (opener) => (opener.startsWith('\\') ? '\\"env\\":\\"<redacted>\\"' : '"env":"<redacted>"'));
  for (const rule of [...TOKEN_SHAPES, ...NAMED_VALUES]) out = typeof rule === 'function' ? rule(out) : out.replace(...rule);
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
