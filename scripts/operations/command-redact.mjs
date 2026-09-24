/**
 * @file scripts/operations/command-redact.mjs
 * @description PURE. The ONE place a host process's raw command line (`ps ... command=`, i.e. its full argv) is
 * made safe to PERSIST into the durable telemetry NDJSON and to PRINT to an operator's terminal
 * (#3383 telemetry-granularity follow-on; PR #2220 review findings).
 *
 * WHY IT EXISTS. `host-process-sample.mjs#processSnapshotMetrics` keeps every substantial process's real
 * identity — its full command line — so a report can say WHICH process took the capacity. Argv is where
 * credentials live on a dev host (`--token=…`, `curl -H 'Authorization: Bearer …'`, `postgres://u:pw@host`),
 * and the telemetry directory is retained across days and shared across every lane clone. Length truncation
 * alone is not a bound on what leaks. So identity is kept and the SECRET-BEARING VALUES are masked.
 *
 * TWO JOBS, ONE FUNCTION (they are applied together at every seam):
 *   1. Mask credential-shaped values — see {@link redactCommandLine}'s rule list.
 *   2. Strip C0/C1 control characters (ESC, BEL, NUL, CR, …) — a crafted process title carrying ANSI/OSC
 *      escapes would otherwise rewrite the operator's screen or title bar when `telemetry-cli report` prints
 *      it. Control characters are replaced with `?`, never dropped silently, so the label stays honest about
 *      having been altered.
 *
 * WHAT THIS DELIBERATELY DOES NOT CATCH (a named gap, not an oversight): a secret with no marker at all — a
 * bare positional argument, `mysql -pSECRET` (no separator), or a token in an unlabeled env-style word — has
 * no shape a regex can tell from an ordinary argument. Same-host `ps` already exposes argv to every local
 * user; this module narrows what is newly written to disk and printed, it is not a secret scanner. For that
 * detector see `scripts/lib/secret-scrub.mjs` (it answers "is this unsafe", not "make it safe").
 */

/** The marker substituted for a masked value. */
export const REDACTED = '[REDACTED]';

/** Bound work before any regex runs; callers still apply their own display/storage length limit. */
export const MAX_REDACT_INPUT = 4096;

/** Substring that makes a flag / variable NAME credential-bearing (case-insensitive). Over-matching (e.g.
 *  `--keyboard`) errs toward masking a harmless value, which is the safe direction for a diagnostic label. */
const SENSITIVE_NAME_RE = /token|key|secret|passw(?:or)?d|pwd|auth|credential|cookie|bearer/i;
/** A quoted or bare value. Quoted forms are kept whole so `--token="a b"` masks the entire argument. */
const VALUE = '(?:"[^"]*"|\'[^\']*\'|[^\\s"\']+)';

// `name=value` — flag (`--api-key=…`) or env-style assignment (`GITHUB_TOKEN=…`), any separator-free form.
// Match each maximal name once, then classify it in the callback. Embedding the sensitive-name
// alternation between unbounded name quantifiers makes repeated `token` words catastrophically slow.
const ASSIGNED = new RegExp(`(?<![\\w.?-])([\\w.?-]+)=(${VALUE})`, 'gi');
// `--name value` — the space-separated flag form. The value must not itself look like a flag (`-…`), so a
// boolean `--no-auth --verbose` does not swallow its neighbour.
const FLAG_SPACED = new RegExp(`(?<![\\w.?-])(--?[\\w.?-]+)(\\s+)(?!-)(${VALUE})`, 'gi');
// `Authorization: Bearer xyz` / `Authorization: xyz` (the header form, usually inside a quoted -H argument).
const AUTH_HEADER = /(authorization\s*[:=]\s*)(?:(?:bearer|basic|token)\s+)?[^\s'"]+/gi;
// A bare `Bearer xyz` / `Basic xyz` with no header name in front of it.
const BARE_SCHEME = /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
// Header names are scanned once. Sticky value patterns consume only a sensitive header's value;
// cookies consume through the next quote/end, including semicolons and spaces.
const HEADER_NAME = /(?<![\w.?-])([\w.?-]+)(\s*:\s*)/g;
const HEADER_VALUE = /(?:(?:bearer|basic|token)\s+)?[^\s'"]+/iy;
const COOKIE_VALUE = /[^'"]+/y;
// `scheme://user:pass@host` — mask the password; and `scheme://TOKEN@host` — mask the lone userinfo.
// A word boundary alone retries the entire scheme at every dot in `a.a.a.…`.
const URL_USER_PASS = /(?<![a-z0-9+.-])\b([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+):([^\s/@]+)@/gi;
const URL_USER_ONLY = /(?<![a-z0-9+.-])\b([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+)@/gi;
// Well-known credential prefixes — a credential is a credential wherever in argv it sits.
const KNOWN_PREFIXES = [
  /\bgh[posru]_[A-Za-z0-9]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{12,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}/g,
];
// C0 (0x00–0x1F), DEL (0x7F) and C1 (0x80–0x9F) control characters.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

function redactHeaders(s) {
  const parts = [];
  let keptThrough = 0;
  HEADER_NAME.lastIndex = 0;
  for (let match; (match = HEADER_NAME.exec(s));) {
    const name = match[1].replace(/\?/g, '');
    if (!SENSITIVE_NAME_RE.test(name)) continue;
    const value = /cookie/i.test(name) ? COOKIE_VALUE : HEADER_VALUE;
    value.lastIndex = HEADER_NAME.lastIndex;
    const found = value.exec(s);
    if (!found) continue;
    HEADER_NAME.lastIndex = value.lastIndex;
    // Preserve the exact spelling already emitted by AUTH_HEADER / BARE_SCHEME.
    if (/^(?:(?:bearer|basic|token)\s+)?\[REDACTED\]$/i.test(found[0])) continue;
    parts.push(s.slice(keptThrough, found.index), REDACTED);
    keptThrough = value.lastIndex;
  }
  parts.push(s.slice(keptThrough));
  return parts.join('');
}

/**
 * PURE, total, never throws. Return `command` with credential-shaped values masked and control characters
 * replaced, ready to persist and print. Rules, applied in this order:
 *   1. Cap input at MAX_REDACT_INPUT, retreating to whitespace in its final 256 characters (or dropping
 *      that window if none exists), and append `…` when truncated. Then neutralise controls to `?`.
 *   2. `Authorization: <scheme> <value>` headers and bare `Bearer`/`Basic <value>` → value masked.
 *   3. Sensitive-name colon headers → optional bearer/basic/token scheme and one word masked; cookie
 *      headers → everything through the next quote/end masked. Already-redacted values stay unchanged.
 *      This covers quoted headers and quote-stripped ps argv, not arbitrary multiline HTTP syntax or
 *      unmarked headers. Non-cookie values containing multiple words are not parsed as a whole.
 *   4. `scheme://user:pass@host` → password masked; `scheme://TOKEN@host` → userinfo masked.
 *   5. `name=value` where `name` contains token/key/secret/password/pwd/auth/credential/cookie/bearer
 *      (a `--flag=value` or an env assignment) → value masked.
 *   6. `--flag value` for the same names → value masked (not when the next word is itself a flag).
 *   7. Known credential prefixes (`ghp_…`, `github_pat_…`, `sk-…`, `xox…`, `AKIA…`, `AIza…`, JWTs) → masked.
 * Order matters: controls are neutralised FIRST so they cannot split a value or hide a sensitive name
 * (name classification ignores `?`). Callers must apply their smaller truncation limit AFTER redaction,
 * or a secret straddling that cut would be left half-visible.
 * @param {*} command
 * @returns {string}
 */
export function redactCommandLine(command) {
  let s = String(command ?? '');
  const truncated = s.length > MAX_REDACT_INPUT;
  if (truncated) {
    const windowStart = MAX_REDACT_INPUT - 256;
    let cut = MAX_REDACT_INPUT - 1;
    // Inspect at most 256 characters, before running any regex on the input.
    while (cut >= windowStart && s[cut].trim() !== '') cut--;
    s = s.slice(0, Math.max(cut, windowStart));
  }
  s = s.replace(CONTROL_CHARS, '?');
  s = s.replace(AUTH_HEADER, `$1${REDACTED}`);
  s = s.replace(BARE_SCHEME, `$1 ${REDACTED}`);
  s = redactHeaders(s);
  s = s.replace(URL_USER_PASS, `$1$2:${REDACTED}@`);
  s = s.replace(URL_USER_ONLY, `$1${REDACTED}@`);
  s = s.replace(ASSIGNED, (match, name) => SENSITIVE_NAME_RE.test(name.replace(/\?/g, '')) ? `${name}=${REDACTED}` : match);
  s = s.replace(FLAG_SPACED, (match, name, space) => SENSITIVE_NAME_RE.test(name.replace(/\?/g, '')) ? `${name}${space}${REDACTED}` : match);
  for (const re of KNOWN_PREFIXES) s = s.replace(re, REDACTED);
  return s + (truncated ? '…' : '');
}
