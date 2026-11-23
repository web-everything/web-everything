/**
 * Strict grammar for a file path an audit reports (PR #6381 redesign). Pure: no I/O, no settings, no repo root.
 *
 *   report = TRIM( ("+++ " | "--- ")? ( Q PATH Q | PATH ) LOC? )
 *   PATH   = [A-Za-z0-9._/-]+          (every tracked file name is in this set)
 *   LOC    = :N | :N-M | :N:C | #LN | #LN-LN
 *
 * `canonicalPaths(file)` returns the repo-relative forms the report names, or `null` when the report is not exactly
 * that shape. `null` means PROTECTED: a caller must treat it as matching every protected glob. Anything the grammar
 * does not list (prose, non-ASCII, escapes, `+`, `@`, backslash, an absolute path, `..` above the root, an empty path)
 * is refused rather than decoded, so no decoding can ever reduce what is protected.
 */
export const MAX_AUDIT_PATH = 512;
/** Most candidates one report may yield (below the old matcher's 32, which counted more forms per path); more cannot be matched at bounded cost and fail closed (protected). */
export const MAX_AUDIT_CANDIDATES = 16;
const GRAMMAR = /^(?:(?:\+\+\+|---) )?(?:(["'`])([A-Za-z0-9._/-]+)\1|([A-Za-z0-9._/-]+))(:\d+(?:-\d+|:\d+)?|#L\d+(?:-L\d+)?)?$/;

/** Collapses `.` and empty segments; null for an empty path, a rooted one, or one holding a `..` segment. */
function normalise(path) {
  if (path.startsWith('/')) return null;
  const parts = [];
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') return null;
    parts.push(seg);
  }
  return parts.length ? parts.join('/') : null;
}

/**
 * The anchors for a list of protected patterns: the lower-case first folder of each (`scripts` of `scripts/**`). A
 * pattern whose first segment holds a wildcard names none. Build `canonicalPaths`'s second argument with this, from the
 * same patterns the caller matches against; the patterns must pass `assertProtectedPatterns` (this throws otherwise).
 */
export function anchorsOf(patterns) {
  assertProtectedPatterns(patterns);
  return new Set(patterns.map(p => p.toLowerCase().split('/')[0]).filter(s => !s.includes('*')));
}

/**
 * `anchors` (REQUIRED, a Set; `anchorsOf(patterns)` builds it, `new Set()` says "no anchors" on purpose): the first
 * folder of each protected glob (`scripts` of `scripts/**`). EVERY form the report yields (as written, side-prefix
 * stripped, line suffix stripped, joined, ...) also yields each trailing sub-path that starts at an anchor, as the old
 * matcher did, so `repo/scripts/x.mjs:42` still reaches `scripts/x.mjs`. Anchors are lower-cased here, so a caller's
 * casing cannot switch the protection off. A missing or non-Set `anchors` throws: leaving it out would silently drop
 * the folder-above-the-repo protection (`repo/scripts/x.mjs` would match no `scripts/**` glob), so it is not a default.
 *
 * The candidates keep the report's casing; a caller matching case-insensitively lower-cases them (and its patterns) itself.
 *
 * A PATH that ends in punctuation (`.` `-` `_` `/`) or holds a `..` segment is refused: no tracked name does either, and
 * the old matcher's trimmed and joined readings of such a name are not worth chasing one by one.
 */
export function canonicalPaths(file, anchors) {
  if (!(anchors instanceof Set)) throw new TypeError('canonicalPaths: anchors must be a Set (anchorsOf(patterns), or new Set() for none)');
  // An anchor is compared with one path segment, so `scripts/lib`, `*` or '' could never match and would silently switch the protection off.
  for (const a of anchors) if (typeof a !== 'string' || a === '.' || a === '..' || !/^[A-Za-z0-9._-]+$/.test(a)) throw new TypeError('canonicalPaths: each anchor must be a single folder name (no "/", "*" or empty), got ' + JSON.stringify(a));
  if (typeof file !== 'string' || file.length > MAX_AUDIT_PATH) return null;
  const text = file.replace(/^ +| +$/g, '');
  // A leading `word:` reads as a URL scheme (`file:x`, or a top-level `x.mjs:42`): refused, as the old matcher did.
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(text)) return null;
  const m = GRAMMAR.exec(text);
  if (!m) return null;
  const path = m[2] ?? m[3];
  if (/[._/-]$/.test(path)) return null;
  const first = normalise(path);
  if (first === null) return null;
  const out = new Set([first]);
  // A git diff side prefix (`a/ b/ c/ i/ w/ o/`) may be a real folder, so the path is read both with and without it.
  if (/^[abciwo]\//.test(path)) { const c = normalise(path.slice(2)); if (c !== null) out.add(c); }
  // A leading run of `-`, `_`, `.` or `/` is a bullet or a hidden-folder dot in prose (`-docs/a.md`): the trimmed name too.
  for (const f of [...out]) {
    const t = f.replace(/^[-_./]+/, '');
    const c = t !== f ? normalise(t) : null;
    if (c !== null) out.add(c);
  }
  // The old matcher also matched the report as written, with every non-path character removed (`custom/x.mjs:42` read
  // as `custom/x.mjs42`), and the line-suffix pieces; kept, so nothing it protected is lost.
  for (const c of [normalise(text), normalise(text.replace(/[^A-Za-z0-9._/-]/g, ''))]) if (c !== null) out.add(c);
  const loc = (m[4] ?? '').slice(1);
  if (loc) for (const d of [loc, ...loc.split(':'), ...(loc.match(/\d+/g) ?? [])]) out.add(d);
  if (anchors.size) {
    const lowered = new Set([...anchors].map(a => String(a).toLowerCase()));
    for (const c of [...out]) {
      const segs = c.split('/');
      for (let i = 1; i < segs.length; i++) {
        if (!lowered.has(segs[i].toLowerCase())) continue;
        const sub = normalise(segs.slice(i).join('/'));
        if (sub !== null) out.add(sub);
      }
    }
  }
  return out.size > MAX_AUDIT_CANDIDATES ? null : [...out];
}

/**
 * Load-time validator for a configured protected pattern (R813(c)). A pattern must itself be a well-formed path or
 * glob under the same strict charset as a report: `[A-Za-z0-9._*-]` segments joined by single `/`, an optional trailing
 * `/` (a directory), no rooted, `.` or `..` segment, no leading `-`, no trailing `.` `-` `_`, at most 512 characters.
 * A settings loader must refuse the whole load (fail closed) on any pattern this returns false for, so a junk pattern
 * (`---a/scripts/x.mjs`, `custom/a+b.mjs`) can never exist for the old matcher's junk readings of a name to hit.
 */
export function validateProtectedPattern(pattern) {
  if (typeof pattern !== 'string' || pattern.length === 0 || pattern.length > MAX_AUDIT_PATH) return false;
  if (!/^[A-Za-z0-9._*-]+(?:\/[A-Za-z0-9._*-]+)*\/?$/.test(pattern) || pattern.startsWith('-')) return false;
  const body = pattern.replace(/\/$/, '');
  if (/[._-]$/.test(body)) return false;
  return body.split('/').every(seg => seg !== '.' && seg !== '..');
}
/** Throws when `patterns` is not an array of well-formed protected patterns; the caller's settings load then fails. */
export function assertProtectedPatterns(patterns) {
  if (!Array.isArray(patterns)) throw new Error('protected patterns must be an array');
  const bad = patterns.filter(p => !validateProtectedPattern(p));
  if (bad.length) throw new Error('malformed protected pattern(s): ' + bad.map(p => JSON.stringify(p)).join(', '));
}

/**
 * Literal globs: * matches within one segment, a run of two or more * spans directories, every other character is
 * literal; a trailing / is a directory prefix. Matched by a bitset state walk (bit i = "pattern token i is next"),
 * never a backtracking regex (PR #6381: nested `**` made a regex take exponential time). Cost is a few bitset
 * operations per path character; path and pattern lengths are bounded upstream.
 */
function matchesPath(file, pattern) {
  if (pattern.endsWith('/')) {
    // A literal directory stays a plain prefix. One holding a wildcard (`custom/**/`, `custom/*/`) was a literal
    // prefix too, so it protected nothing (PR #6381 judge): it now matches like the same glob without the trailing
    // slashes, or anything under what that glob matches. Matching more only ever protects more.
    if (!pattern.includes('*')) return file.startsWith(pattern);
    const dir = pattern.replace(/\/+$/, '');
    return globMatch(file, dir) || globMatch(file, `${dir}/**`);
  }
  return globMatch(file, pattern);
}
function globMatch(file, pattern) {
  const lit = new Map(); let star = 0n; let globstar = 0n; let n = 0n;
  for (let i = 0; i < pattern.length; n++) {
    const bit = 1n << n;
    if (pattern[i] !== '*') { lit.set(pattern[i], (lit.get(pattern[i]) ?? 0n) | bit); i++; continue; }
    let j = i; while (pattern[j] === '*') j++;
    if (j - i >= 2) globstar |= bit; else star |= bit;
    i = j;
  }
  const wild = star | globstar;
  // A wildcard may match nothing, so reaching it also reaches the next token. Runs of * are one token, so a
  // wildcard is never followed by another and one shift closes the set.
  const close = s => s | ((s & wild) << 1n);
  let s = close(1n);
  for (let c = 0; c < file.length; c++) {
    const ch = file[c];
    s = close((s & (ch === '/' ? globstar : wild)) | ((s & (lit.get(ch) ?? 0n)) << 1n));
    if (s === 0n) return false;
  }
  return ((s >> n) & 1n) === 1n;
}

/**
 * Legacy cleanup for caller-supplied patterns; configured settings are validated before this fold.
 * Compatibility form (NFKC); invisible, control, format, line and paragraph separator
 * characters and the blank Braille pattern dropped; the dash, slash and dot lookalikes NFKC keeps (U+2011, U+2212,
 * U+2215, U+3002, ...) read as `-`, `/` and `.`. Written as escapes: a raw invisible in source is refused by check:standards.
 */
const foldPathText = s => s.normalize('NFKC')
  .replace(/[\p{Default_Ignorable_Code_Point}\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u{2800}]/gu, '')
  .replace(/[\p{Pd}\u{2212}\u{2043}]/gu, '-')
  .replace(/[\u{2215}\u{2044}\u{2216}\u{29f5}\u{29f8}\u{29f9}]/gu, '/')
  .replace(/[\u{b7}\u{589}\u{6d4}\u{2027}\u{2219}\u{22c5}\u{2e31}\u{2e33}\u{3002}\u{30fb}]/gu, '.');
// Case-insensitive: the checkout may sit on a case-insensitive file system, where `Scripts/Guard-Bash.mjs` IS the guard.
// Folding both sides only ever protects more paths. The candidates are computed once per path, not once per glob.
// A pattern is cleaned up the way a path candidate is (PR #6381 self-review), else `./custom/**`, `/custom/**`,
// `custom/./**`, `custom<U+200B>/**` or a fullwidth letter matched no candidate and protected nothing: compatibility form
// (NFKC), surrounding whitespace trimmed, invisible, control and format characters dropped, `\` read as `/`, empty and
// `.` segments dropped, `..` resolved. A pattern that cleans up to nothing (`./`, `/`) names the repo root, and one that
// climbs above it (`../x`) cannot be placed: both protect every path. A trailing `/` (a directory) is kept.
const cleanPattern = p => {
  // Trimmed AFTER the invisible characters go, so a space beside one (`custom/** <U+200B>`) is trimmed too.
  const s = foldPathText(p).trim().replace(/\\/g, '/');
  const segs = [];
  for (const seg of s.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (!segs.length) return '**'; segs.pop(); continue; }
    segs.push(seg);
  }
  if (!segs.length) return '**';
  return `${segs.join('/')}${s.endsWith('/') ? '/' : ''}`.toLowerCase();
};
export const matchesSome = (file, patterns) => {
  const clean = patterns.map(cleanPattern);
  const c = canonicalPaths(file, anchorsOf(clean));
  return c === null || clean.some(p => c.some(x => matchesPath(x.toLowerCase(), p)));
};
