// TEST-ONLY ORACLE: the pre-redesign matcher copied verbatim from PR #6381 head d6f2afde (scripts/operations/audit-verdict.mjs
// lines 40-77 and 140-285) so audit-path.test.mjs can prove the strict grammar never protects LESS. Never imported at runtime.
const REPO_ROOT = '/oracle-repo-root/';
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
/** Longest reported path matched against globs; a longer one cannot be established and fails closed (bounds glob cost). */
const MAX_PATH = 512;
/** Most globs one CALLER list may carry (the trusted lists are bounded by audit-settings: the floor plus 256 per layer). */
/** Most candidate forms one reported path may yield; more cannot be matched at bounded cost and fail closed. */
const MAX_CANDIDATES = 32;
/**
 * The one fold a reported path and a protected pattern both go through (PR #6381 referral: the two sides dropped
 * different characters): compatibility form (NFKC); invisible, control, format, line and paragraph separator
 * characters and the blank Braille pattern dropped; the dash, slash and dot lookalikes NFKC keeps (U+2011, U+2212,
 * U+2215, U+3002, ...) read as `-`, `/` and `.`. Written as escapes: a raw invisible in source is refused by check:standards.
 */
const foldPathText = (s, gap = '') => s.normalize('NFKC')
  .replace(/[\p{Default_Ignorable_Code_Point}\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u{2800}]/gu, gap)
  .replace(/[\p{Pd}\u{2212}\u{2043}]/gu, '-')
  .replace(/[\u{2215}\u{2044}\u{2216}\u{29f5}\u{29f8}\u{29f9}]/gu, '/')
  .replace(/[\u{b7}\u{589}\u{6d4}\u{2027}\u{2219}\u{22c5}\u{2e31}\u{2e33}\u{3002}\u{30fb}]/gu, '.');
/**
 * Every repo-relative POSIX form a reported path may name, or null when it cannot be established (callers fail closed).
 * A model reading a diff or a trace wraps the file in text the floor globs never match: quotes or backticks, a diff
 * header or side prefix (`+++ b/`, `a/`, `i/`), a folder above the repo, a line suffix (`:42`, `:42-50`, `#L42`,
 * `(line 42)`, `@sha`), trailing punctuation, compatibility-form or invisible characters (PR #6381 self-review).
 * Listing those shapes always misses the next one, so the shape is not listed: every run of path characters in the
 * report (raw and NFKC-folded) is a token and a candidate, and so is every trailing run of the token's folders that
 * starts at an ANCHOR, the first folder a protected glob names (`scripts`, `.claude`). Anchoring keeps a glob's
 * meaning (`*` still names only a top-level file: `x/y` never yields `y`). A path is protected when ANY candidate
 * matches, so a candidate only ever protects more. The raw report must still normalize.
 */
function pathCandidates(file, anchors = new Set()) {
  if (typeof file !== 'string' || file.length > MAX_PATH) return null;
  const raw = pathCandidate(file);
  if (raw === null) return null;
  const out = new Set([raw]);
  // PR #6381 self-review: a model may escape a character inside a name (markdown `review\-x.mjs`, `%2B`, `&#43;`), so the
  // report is also read with those ASCII escapes decoded. Like every other form, it only adds candidates.
  for (const text of new Set([file, unescapeAscii(file)])) if (!addCandidates(text, anchors, out)) return null;
  return [...out];
}
/** ASCII-only decoding of the escapes a model writes inside a name: `%XX`, numeric HTML entities, a markdown `\` escape. */
const unescapeAscii = s => s
  .replace(/%([0-7][0-9A-Fa-f])/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
  .replace(/&#(?:[xX]([0-9A-Fa-f]{1,2})|(\d{1,3}));/g, (m, h, d) => {
    const n = h ? parseInt(h, 16) : Number(d);
    return n < 0x80 ? String.fromCharCode(n) : m;
  })
  .replace(/\\([!-/:-@[-`{-~])/g, '$1');
/** Adds every candidate `file` yields to `out`; false when the report cannot be established (callers fail closed). */
function addCandidates(file, anchors, out) {
  // PR #6381 referral (block): a character that NFKC keeps split the folded token, so an explicitly named module
  // matched no glob. Listing such characters always misses the next one (a format character, then a lookalike dash,
  // then a combining mark), so the fold maps the separators a path uses and then REFUSES what is left: a token that
  // still holds a non-ASCII letter, number, mark or symbol next to a path character cannot be established, and the
  // path fails closed (protected). Every tracked file name is ASCII, so no real path is refused. A second form also
  // drops whitespace, which renders as a gap inside a name. Each form only adds candidates; the raw report stays one.
  // A run is what sits between whitespace. Punctuation and symbols at its edges are prose (a curly-quoted or bracketed
  // path, a trailing ideographic full stop); what is left is the run's core. A core that still mixes a non-ASCII
  // character with an ASCII letter refuses the report, wherever the character sits and whatever it looks like (a
  // bracket inside a name, a box-drawing slash in place of every `/`). Non-ASCII prose (no ASCII letter) still passes.
  const folded = foldPathText(file);
  const cores = folded.split(/\s+/u).map(run => run.replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, ''));
  if (cores.some(core => /[^\x00-\x7f]/.test(core) && /[A-Za-z]/.test(core))) return false;
  // Forms: the raw report, the fold, the fold without whitespace, and the fold keeping only path characters, so any
  // splitter inside a name (a gap, a bracket, `,`, `!`, `:`, a symbol stripped above as an edge) joins it up again.
  const joined = folded.replace(/\s/gu, '');
  const tokens = [];
  for (const form of new Set([file, folded, joined, folded.replace(/[^\p{L}\p{N}\p{M}_.\-/\\]/gu, '')])) {
    tokens.push(...(form.match(/[\p{L}\p{N}_.\-/\\]+/gu) ?? []));
  }
  // PR #6381 judge: the token regex splits on any ASCII character it does not list (`+`, `@`, `~`, `%`, `=`, `,`), so a
  // legal name such as custom/a+b.mjs never matched once quoted, line-suffixed or diff-prefixed. Adding characters to
  // the regex always misses the next one, so the cores are tokens too: only their edges were trimmed, so every
  // interior character stays. Wrapping prose may still sit inside a core (`"a+b.mjs":12`, `[x](a+b.mjs)`, `a+b.mjs?x=1`,
  // two names joined by `,`), and no list of those characters is complete either, so each whitespace run is cut at
  // EVERY punctuation or symbol that is not a path character, and every span between two cuts that reads as a path (a
  // letter and a `/`, `\` or `.`) is a token; a span of prose (`render(`, `label,`) only spends the candidate bound. The run is cut untrimmed, so a name that itself starts or ends with such a character (`+a.mjs`, `a.mjs+`)
  // keeps it in some span. The runs are taken from a second fold too, where a dropped invisible or line separator is a
  // gap rather than nothing, so prose it glued onto a name is cut off. The whitespace-joined form is a token as it
  // stands, never cut: cutting a whole report would pair every two marks in it. More candidates still fail closed.
  const edges = s => s.replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, '');
  tokens.push(...cores, edges(joined));
  for (const run of new Set([...folded.split(/\s+/u), ...foldPathText(file, ' ').split(/\s+/u)])) {
    const cuts = [-1];
    for (let i = 0; i < run.length; i++) if (/[^\p{L}\p{N}\p{M}_.\-/\\]/u.test(run[i])) cuts.push(i);
    // Spans grow with the square of the cuts: a run with more cuts than the candidate bound fails closed (protected).
    if (cuts.length > MAX_CANDIDATES + 1) return false;
    cuts.push(run.length);
    for (let a = 0; a < cuts.length - 1; a++) {
      for (let b = a + 1; b < cuts.length; b++) {
        const span = run.slice(cuts[a] + 1, cuts[b]);
        if (/[./\\]/.test(span) && /\p{L}/u.test(span)) tokens.push(span);
      }
    }
  }
  for (const token of tokens) {
    if (token === '') continue;
    const segs = token.replace(/\\/g, '/').replace(/\.+$/, '').split('/').filter(s => s !== '' && s !== '.');
    for (let i = 0; i < segs.length; i++) {
      if (i > 0 && !anchors.has(segs[i].toLowerCase())) continue;
      const c = pathCandidate(segs.slice(i).join('/'));
      if (c !== null) out.add(c);
      if (out.size > MAX_CANDIDATES) return false;
    }
  }
  return true;
}
/** The literal first folder of each glob (`scripts` of `scripts/**\/x`); a glob that starts with a wildcard names none. */
const anchorsOf = patterns => new Set(patterns.map(p => p.toLowerCase().split('/')[0]).filter(s => s !== '' && !s.includes('*')));
function pathCandidate(file) {
  if (/[\u0000-\u001f]/.test(file) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(file)) return null;
  let path = file.replace(/\\/g, '/');
  if (path.startsWith('/')) {
    if (!path.startsWith(REPO_ROOT.replace(/\\/g, '/'))) return null;
    path = path.slice(REPO_ROOT.length);
  }
  const parts = [];
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (!parts.length) return null; parts.pop(); continue; }
    parts.push(seg);
  }
  return parts.length ? parts.join('/') : null;
}
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
const matchesSome = (file, patterns) => {
  const clean = patterns.map(cleanPattern);
  const c = pathCandidates(file, anchorsOf(clean))?.map(x => x.toLowerCase());
  return c === undefined || clean.some(p => c.some(x => matchesPath(x, p)));
};
export { matchesSome as oracleMatchesSome, pathCandidates as oraclePathCandidates, cleanPattern as oracleCleanPattern, anchorsOf as oracleAnchorsOf, matchesPath as oracleMatchesPath };
