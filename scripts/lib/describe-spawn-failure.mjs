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
// structural rules below redact by POSITION — a whole `--settings` object, a whole `env` object or array, the
// value of any credential-named key or flag — and the token-shape rules only catch what leaks outside those.
// `token(?!s)` spares telemetry like `input_tokens`; `auth` spares only `author(s)`; a bare `key` (an effect
// key) is not a credential, but `API_KEY`, `ssh-key` and `KEY_ID` are.
const CRED_TERM = /token(?!s)|secret|passw(?:or)?d|api[_-]?key|private[_-]?key|access[_-]?key|auth(?!ors?(?![a-z]))|credential|cookie|[_.-]key(?![a-z0-9])|^key[_.-]/i;

/** Whether a key, flag or variable name names a credential (or `PATH`, which carries the gh-shim directory). */
function isCredName(name) {
  return name === 'PATH' || CRED_TERM.test(String(name).replace(/^-+/, ''));
}

/** The length of the backslash run starting at `i`. */
function backslashRun(text, i) {
  let run = 0;
  while (text[i + run] === '\\') run += 1;
  return run;
}

/**
 * The index just past the quoted string whose opening delimiter (`depth` backslashes, then `"`) starts at
 * `start`; `text.length` when it never closes, so an unterminated value is redacted to the end, never leaked.
 * At depth 0 a quote closes after an even run of backslashes (JSON); at depth k after exactly k (JSON encoded
 * k levels deep), so a quote escaped one level further inside the value does not end it.
 */
function quotedEnd(text, start, depth) {
  for (let i = start + depth + 1; i < text.length; i += 1) {
    const run = backslashRun(text, i);
    if (text[i + run] === '"' && (run === depth || (depth === 0 && run % 2 === 0))) return i + run + 1;
    i += run;
  }
  return text.length;
}

/** The end index (exclusive) of the balanced `{…}` / `[…]` starting at `open`, skipping quoted strings at the
 *  escape depth of the first quote inside it; `text.length` when it never closes. */
function objectEnd(text, open) {
  let depth = 0;
  let quoteDepth = null;
  for (let i = open; i < text.length; i += 1) {
    const run = backslashRun(text, i);
    if (text[i + run] === '"') {
      quoteDepth ??= run;
      if (run === quoteDepth) i = quotedEnd(text, i, run) - 1;
      else i += run;
    } else if (run) {
      i += run;
    } else if (text[i] === '{' || text[i] === '[') depth += 1;
    else if ((text[i] === '}' || text[i] === ']') && --depth === 0) return i + 1;
  }
  return text.length;
}

/** Replace every object or array that follows `opener` (a global regex whose match ends just before it; a `q`
 *  group is an opening shell quote to consume at the close). `replacement` receives the opener match. */
function redactObjects(text, opener, replacement) {
  let out = '';
  let from = 0;
  for (const m of text.matchAll(opener)) {
    const open = m.index + m[0].length;
    if (m.index < from) continue;
    let end = objectEnd(text, open);
    if (m.groups?.q && text[end] === m.groups.q) end += 1; // the closing shell quote of `--settings '{…}'`
    out += text.slice(from, m.index) + replacement(m);
    from = end;
  }
  return out + text.slice(from);
}

/**
 * A rule that redacts the value after every credential-named key. `nameRe` (global) matches `<name><separator>`
 * with the name in group `name`; `valueEnd(text, at, m)` (the end of the value at `at`, or -1 for none) runs
 * only after a credential name, so a non-credential `failed: GH_TOKEN=x` neither swallows the `GH_TOKEN` after
 * it nor rescans the rest of the text. A value already `<redacted…>` is left as it is. `replacement` gets `m`.
 */
function namedValueRule(nameRe, valueEnd, replacement) {
  return (text) => {
    let out = '';
    let from = 0;
    nameRe.lastIndex = 0;
    for (let m = nameRe.exec(text); m; m = nameRe.exec(text)) {
      const at = nameRe.lastIndex;
      if (!isCredName(m.groups.name) || text.startsWith('<redacted', at)) continue;
      const end = valueEnd(text, at, m);
      if (end <= at) continue;
      out += text.slice(from, m.index) + replacement(m);
      from = end;
      nameRe.lastIndex = from;
    }
    return out + text.slice(from);
  };
}

/** A sticky regex as a `valueEnd`. */
const stickyEnd = (re) => (text, at) => {
  re.lastIndex = at;
  return re.exec(text) ? re.lastIndex : -1;
};

// A `"` (raw or escaped) followed by `,` `}` `]` `:`, the line end or the end closes the JSON string a value
// sits in; any other `"` can open a quoted part of the value (`a=''"…"`, `sid="…"`), so a value never ends
// early at one.
const NOT_JSON_CLOSE = String.raw`(?![ \t]*(?:[,}\]:\r\n]|$))`;
/**
 * A JSON-escaped quoted part (`\"…\"`, `\\\"…\\\"`) whose backslash run is captured as `group`. It closes at a
 * quote escaped exactly as deep, runs on through quotes escaped deeper, and — unclosed — stops at a shallower
 * quote (the string it sits in closing) or the line end, never past them. The run is matched only from its
 * start, so a long run of backslashes is scanned once.
 */
const escapedPart = (group) => String.raw`(?<!\\)(?<${group}>\\+)"${NOT_JSON_CLOSE}` +
  String.raw`(?:[^"\\\r\n]|\\+(?![\\"])|\k<${group}>\\+")*(?:\k<${group}>")?`;
// A shell-ish value: an optional leading double-quoted string, then any concatenation of quoted ('…', "…",
// `…`, $'…', a JSON-escaped \"…\") and bare parts — `'it'\''s secret'`, `''"secret"` and `a"secret"` are one
// value. A bare part stops at `"`, `]`, `}`, `,` and `;`. A `"` after a bare part continues the value only when
// its quoted part closes before a word break (`a"x" node`), so `msg="… token=abc" err=401` keeps `" err=401`;
// after a quote it does unless it closes the surrounding JSON string. Quoted parts stop at the line end.
const SHELL_PART = String.raw`'[^']*(?:'|$)|\x60[^\x60]*(?:\x60|$)|\$'(?:[^'\\]|\\.)*(?:'|$)` +
  String.raw`|(?<=['"\x60])"${NOT_JSON_CLOSE}(?:[^"\\\r\n]|\\[^\r\n])*"?|"[^"\r\n]*"(?=[\s;&|)]|$)` +
  String.raw`|${escapedPart('sb')}|\\[^"]|[^\s"'\x60\\\],};]`;
const SHELL_VALUE = new RegExp(String.raw`(?:"(?:[^"\\]|\\.)*(?:"|$))?(?:${SHELL_PART})*`, 'y');
/** A shell value, or a whole `{…}`/`[…]` (`{ GH_TOKEN: [ 'x' ] }`, a JS-inspected object). */
const shellOrContainerEnd = (text, at) => (text[at] === '{' || text[at] === '[' ? objectEnd(text, at) : stickyEnd(SHELL_VALUE)(text, at));
// Names are matched as ONE bounded identifier that starts where no identifier character precedes it, then
// tested by `isCredName` — so a long run of identifier characters is scanned once, never quadratically.
const IDENT = String.raw`(?<![A-Za-z0-9_.-])(?<name>[A-Za-z0-9_.-]{1,128})`;

/** The value of a JSON key at `at`: a string at the key's own escape depth, a whole object or array
 *  (`{"Authorization":["Basic …"]}`), else a bare scalar. */
function jsonValueEnd(text, at, m) {
  const depth = m.groups.bs.length;
  if (text.startsWith(`${m.groups.bs}"`, at)) return quotedEnd(text, at, depth);
  if (text[at] === '{' || text[at] === '[') return objectEnd(text, at);
  const bare = /[^,}\]\s\\"]+/y;
  bare.lastIndex = at;
  return bare.exec(text) ? bare.lastIndex : -1;
}

const HEADER_NAME = String.raw`(?:proxy-)?authorization|(?:set-)?cookie|x-[a-z0-9-]{0,64}(?:token|key|secret|auth)[a-z0-9-]{0,64}` +
  String.raw`|(?:[a-z0-9]{1,32}-){0,3}(?:api-key|private-token|access-token|auth-token)`;
// A `"` opens a quoted part (`a="1"`, `x-api-key: "…"`, Digest's `response="…"`, `sid=ab"…`) of ANY length:
// an unclosed one runs to the end of the line, so it never fails and is never rescanned. A quote that closes the
// surrounding JSON string (NOT_JSON_CLOSE) opens nothing — so `{"e":"Cookie: a ","ok":1}` keeps its `,"ok"` —
// unless, right after `=`, `:` or a space, its quoted part closes before `;`, `,`, a space or the end
// (`sid=",…"`). A `'` right after one of those opens a single-quoted part (`authorization: 'Basic …'`).
const HEADER_VALUE = String.raw`(?:"${NOT_JSON_CLOSE}(?:[^"\r\n\\]|\\[^\r\n])*"?|(?<=[=:\s])"[^"\r\n]*"(?=[;,\s]|$)` +
  String.raw`|(?<=[=:\s])'[^'\r\n]*'?|${escapedPart('hb')}|\\\\|\\[^nr"'\\]|'\\''|\r?\n[ \t]+|(?:\\r)?\\n[ \t]+|[^\r\n"'\\])*`;
// One cookie list: quoted or bare parts, carried across `; ` when another `name=` follows (an env dump's form).
// Unbounded: a quoted part stops at its line, and every match ends where the next begins, so it stays linear.
const COOKIE_LIST = String.raw`(?:'[^'\r\n]*'?|"${NOT_JSON_CLOSE}(?:[^"\\\r\n]|\\[^\r\n])*"?|${escapedPart('cb')}` +
  String.raw`|;[ \t]+(?=[A-Za-z0-9_.%-]{1,64}=)|[^\s"'\\])+`;

const TOKEN_SHAPES = [
  [/\b(?:gh[posru]_|github_pat_)[A-Za-z0-9_]{8,}/g, '<redacted-token>'],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, '<redacted-token>'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}/g, '<redacted-jwt>'],
];

const NAMED_VALUES = [
  // `"GH_TOKEN": "…"` at any JSON-encoding depth (`\"GH_TOKEN\":\"…\"`, `\\\"…`). The key is kept.
  namedValueRule(/(?<!\\)(?<bs>\\*)"(?<name>[^"\\]{1,128})\k<bs>"\s*:\s*/g, jsonValueEnd,
    (m) => `${m[0]}${m.groups.bs}"<redacted-env>${m.groups.bs}"`),
  // `{"name":"GH_TOKEN","value":"…"}` — an env entry given as a name/value pair.
  namedValueRule(/(?<!\\)(?<bs>\\*)"name\k<bs>"\s*:\s*\k<bs>"(?<name>[^"\\]{1,128})\k<bs>"\s*,\s*\k<bs>"value\k<bs>"\s*:\s*/g,
    jsonValueEnd, (m) => `${m[0]}${m.groups.bs}"<redacted-env>${m.groups.bs}"`),
  // A credential HEADER's whole value, not its first `;`/`,` part: `Cookie: theme=light; session=…` carries the
  // secret in a later cookie (PR #5472 red team). The value runs on through quoted cookie values (`a="1"`, raw or
  // JSON-escaped), escaped characters, a shell quote break (`'\''`) and folded continuation lines; it ends at the
  // line, a bare quote, or an escaped newline/quote, so a header inside a JSON string never eats its closing quote.
  [new RegExp(String.raw`\b(${HEADER_NAME})[ \t]*:${HEADER_VALUE}`, 'gi'), '$1: <redacted>'],
  [new RegExp(String.raw`\b(${HEADER_NAME})%3A[^\s&"'<>]*`, 'gi'), '$1%3A<redacted>'],
  // `["Cookie","a=1; s=…"]`, `["--token","…"]` — a header list or argv array: the string after a credential name.
  // Only an ARRAY element that is a flag or a header name: an object value (after `:`), a key (before `:`) or a
  // subcommand word (`["gh","auth","login"]`) never matches.
  namedValueRule(new RegExp(String.raw`(?<=[[,]\s{0,8})(?<bs>\\*)"(?<name>-{1,2}[A-Za-z0-9_.-]{1,128}|${HEADER_NAME})\k<bs>"\s*,\s*(?=\k<bs>"|[[{])`, 'gi'),
    jsonValueEnd, (m) => `${m[0]}${m.groups.bs}"<redacted-env>${m.groups.bs}"`),
  // `COOKIE=a=1; s=…`, `--cookie a=1;s=…`, curl's `-b 'a=1; s=…'` / `-b'…'`: a cookie list is one value, `;` included.
  // A space-separated value only follows a FLAG, so prose (`cookie consent`) is left alone.
  [new RegExp(String.raw`(?<![A-Za-z0-9_.-])([A-Za-z0-9_.-]{0,64}cookie[A-Za-z0-9_.-]{0,64})(\s*=\s*)${COOKIE_LIST}`, 'gi'), '$1$2<redacted>'],
  [new RegExp(String.raw`(?<![A-Za-z0-9_.-])(-{1,2}[A-Za-z0-9_.-]{0,64}cookie[A-Za-z0-9_.-]{0,64})([ \t]+)${COOKIE_LIST}`, 'gi'), '$1$2<redacted>'],
  // `-b` only on a line after `curl`, however far along it: each such line is rewritten once, so it stays linear.
  ((re) => (text) => text.replace(/\bcurl\b[^\r\n]*/g, (line) => line.replace(re, '-b$1<redacted>')))(
    new RegExp(String.raw`(?<=\s)-b([ \t]*)(?=\S)${COOKIE_LIST}`, 'g')),
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer <redacted>'],
  // `GH_TOKEN=…`, `export X_API_KEY=…`, `password: …`, `--token=…`, `{ GH_TOKEN: [ 'x' ] }`.
  namedValueRule(new RegExp(String.raw`${IDENT}\s*[:=]\s*`, 'g'), shellOrContainerEnd, (m) => `${m[0]}<redacted>`),
  // `{'GH_TOKEN': '…'}` — a single-quoted key (a Python or JS-inspected dict).
  namedValueRule(/(?<![A-Za-z0-9_.-])'(?<name>[A-Za-z0-9_.-]{1,128})'\s*:\s*/g, shellOrContainerEnd, (m) => `${m[0]}<redacted>`),
  // `--token …`, `-password …` — a flag whose value is the next word (never the next flag).
  namedValueRule(new RegExp(String.raw`(?<![A-Za-z0-9_.-])-{1,2}(?<name>[A-Za-z0-9_.-]{1,128})[ \t]+`, 'g'),
    (text, at) => (text[at] === '-' ? -1 : stickyEnd(SHELL_VALUE)(text, at)), (m) => `${m[0]}<redacted>`),
  // URL userinfo: `https://user:pass@host` and `https://TOKEN@host` alike.
  [/(?<![a-z0-9+.-])([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/@]+@/gi, '$1<redacted>@'],
];

/** Literal values of this process's credential-named env vars, longest first (a value can contain another). */
function envSecretValues(env) {
  return Object.entries(env ?? {})
    .filter(([key, value]) => key !== 'PATH' && isCredName(key) && typeof value === 'string' && value.length >= 8)
    .map(([, value]) => value).sort((a, b) => b.length - a.length);
}

/**
 * Redact credentials from free text: any `--settings {…}` JSON, any `"env"` object or array, the value of every
 * credential-named key (JSON at any encoding depth, shell, flag or header form), URL userinfo, token-shaped
 * strings, and the literal value of this process's own credential-named env vars. PURE but for the `env`
 * default.
 * @param {unknown} text
 * @param {{env?: Record<string, string|undefined>}} [opts]
 */
export function redactSpawnText(text, { env = process.env } = {}) {
  let out = String(text ?? '');
  for (const value of envSecretValues(env)) out = out.split(value).join('<redacted-env>');
  out = redactObjects(out, /--settings(?:\s+|=)(?<q>['"]?)(?=\{)/g, () => '--settings <redacted>');
  out = redactObjects(out, /(?<!\\)(?<bs>\\*)"env\k<bs>"\s*:\s*(?=[{[])/gi,
    (m) => `${m.groups.bs}"env${m.groups.bs}":${m.groups.bs}"<redacted>${m.groups.bs}"`);
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
