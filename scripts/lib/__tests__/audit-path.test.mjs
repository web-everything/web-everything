import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { canonicalPaths } from '../audit-path.mjs';
import { oracleMatchesSome, oraclePathCandidates, oracleAnchorsOf, oracleCleanPattern, oracleMatchesPath } from './fixtures/audit-path-old-oracle.mjs';

const PATTERNS = ['scripts/guard-bash.mjs', 'scripts/lib/**', '.claude/**', 'custom/**', 'custom/a+b.mjs', 'review-x.mjs', 'docs/', 'guard-*.mjs', '4-9', 'L3-L9', '1', 'L42', '42-50'];
const lower = a => a.map(x => x.toLowerCase());
const globOk = (p, pat) => {
  if (pat.endsWith('/')) return p.startsWith(pat);
  const re = new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0001').replace(/\*/g, '[^/]*').replace(/\u0001/g, '.*') + '$');
  return re.test(p);
};
/** The new matcher as a caller uses it: null is protected, otherwise any candidate matches any pattern. */
const ANCHORS = oracleAnchorsOf(PATTERNS.map(oracleCleanPattern));
const protects = (file, patterns = PATTERNS) => {
  const c = canonicalPaths(file, ANCHORS);
  return c === null || lower(c).some(x => patterns.some(p => globOk(x, p.toLowerCase())));
};

describe('P1 every past bypass is protected (#6381 rounds 1-15)', () => {
  const U = s => s.replace(/<(\w+)>/g, (_, h) => String.fromCodePoint(parseInt(h, 16)));
  const corpus = {
    'plain name': 'scripts/guard-bash.mjs',
    'double quotes': '"scripts/guard-bash.mjs"',
    'single quotes': "'scripts/guard-bash.mjs'",
    'backticks': '`scripts/guard-bash.mjs`',
    'diff header +++ b/': '+++ b/scripts/guard-bash.mjs',
    'diff header --- a/': '--- a/scripts/guard-bash.mjs',
    'git side prefix i/': 'i/scripts/guard-bash.mjs',
    'git side prefix w/': 'w/scripts/guard-bash.mjs',
    'absolute path': '/home/dev/repo/scripts/guard-bash.mjs',
    'line suffix :42': 'scripts/guard-bash.mjs:42',
    'line range :42-50': 'scripts/guard-bash.mjs:42-50',
    'line:col': 'scripts/guard-bash.mjs:42:7',
    'anchor #L42': 'scripts/guard-bash.mjs#L42',
    'anchor range #L42-L50': 'scripts/guard-bash.mjs#L42-L50',
    '(line 42)': 'scripts/guard-bash.mjs (line 42)',
    '@sha': 'scripts/guard-bash.mjs@abc1234',
    'trailing period': 'scripts/guard-bash.mjs.',
    'trailing comma': 'scripts/guard-bash.mjs,',
    'dot segment': './scripts/./guard-bash.mjs',
    'dotdot climb': 'x/../scripts/guard-bash.mjs',
    'above the root': '../scripts/guard-bash.mjs',
    'leading slash': '/scripts/guard-bash.mjs',
    'backslash separator': 'scripts\\guard-bash.mjs',
    'uppercase (case-insensitive fs)': 'Scripts/Guard-Bash.mjs',
    'top-level name with line suffix reads as a scheme': 'review-x.mjs:42',
    'plus in name': 'custom/a+b.mjs',
    'plus in name, quoted + line': '"custom/a+b.mjs":12',
    'plus in name, markdown link': '[x](custom/a+b.mjs)',
    'plus in name, query': 'custom/a+b.mjs?x=1',
    'two names joined by comma': 'custom/x.mjs,scripts/guard-bash.mjs',
    'markdown escape': 'review\\-x.mjs',
    'percent escape': 'custom/a%2Bb.mjs',
    'html entity': 'custom/a&#43;b.mjs',
    'fullwidth letters (NFKC)': U('<ff53>cripts/guard-bash.mjs'),
    'zero-width space in name': U('scripts/guard<200b>-bash.mjs'),
    'zero-width space after folder': U('custom<200b>/x.mjs'),
    'arabic number sign U+0600': U('scripts/guard<600>-bash.mjs'),
    'non-breaking hyphen U+2011': U('scripts/guard<2011>bash.mjs'),
    'minus sign U+2212': U('scripts/guard<2212>bash.mjs'),
    'division slash U+2215': U('scripts<2215>guard-bash.mjs'),
    'ideographic full stop U+3002': U('scripts/guard-bash<3002>mjs'),
    'blank braille U+2800': U('scripts/guard<2800>-bash.mjs'),
    'curly quotes': U('<201c>scripts/guard-bash.mjs<201d>'),
    'box-drawing slash': U('scripts<2571>guard-bash.mjs'),
    'combining mark': U('scripts/guard-bash.mjs<301>'),
    'line separator': U('scripts/guard-bash.mjs<2028>x'),
    'newline inside': 'scripts/guard-bash.mjs\nx',
    'NUL byte': 'scripts/guard-bash.mjs\u0000',
    'url scheme': 'file:scripts/guard-bash.mjs',
    'prose around a name': 'I changed scripts/guard-bash.mjs to relax it',
    'empty': '',
    'dot only': '.',
    'root only': '/',
    'over the length bound': 'scripts/' + 'a'.repeat(600) + '.mjs',
    'non-string': 42,
    'mismatched quotes': '"scripts/guard-bash.mjs\'',
    'glob wildcard in report': 'scripts/*',
  };
  for (const [name, file] of Object.entries(corpus)) {
    it('bypass row: ' + name, () => { expect(protects(file)).toBe(true); });
  }
  it('refuses (null) everything outside the grammar', () => {
    for (const k of ['custom/a+b.mjs', '"custom/a+b.mjs":12', 'scripts/guard-bash.mjs (line 42)', '', '/x', '../x', 'a\\b', 'a b']) {
      expect(canonicalPaths(k)).toBeNull();
    }
  });
  it('reads the accepted shapes', () => {
    expect(canonicalPaths('scripts/x.mjs')).toEqual(['scripts/x.mjs']);
    expect(canonicalPaths('  "./scripts//x.mjs":4-9 ')).toEqual(['scripts/x.mjs', '"./scripts/x.mjs":4-9', '4-9', '4', '9']);
    expect(canonicalPaths('+++ b/scripts/x.mjs')).toEqual(['b/scripts/x.mjs', 'scripts/x.mjs', '+++ b/scripts/x.mjs']);
    expect(canonicalPaths('a/x.mjs#L3-L9')).toEqual(['a/x.mjs', 'x.mjs', 'a/x.mjs#L3-L9', 'L3-L9', '3', '9']);
    expect(canonicalPaths('scripts/x.mjs:1:2')).toEqual(['scripts/x.mjs', 'scripts/x.mjs:1:2', '1:2', '1', '2']);
    expect(canonicalPaths('scripts/x.mjs.')).toEqual(['scripts/x.mjs.', 'scripts/x.mjs']);
    expect(canonicalPaths('-docs/a.md')).toEqual(['-docs/a.md', 'docs/a.md']);
    expect(canonicalPaths('./x.mjs')).toEqual(['x.mjs']);
  });
});

/** Seeded generator (mulberry32) so a failure replays. */
const rng = seed => () => {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const FRAGS = ['scripts', 'lib', 'guard-bash.mjs', 'custom', 'a+b.mjs', '.claude', 'x', '..', '.', '/', '/', '/', '"', "'", '`', '+++ ', '--- ', 'a/', 'b/', ':42', ':4-9', ':1:2', '#L3', '#L3-L9', ' ', '\t', '\n', '(', ')', '[', ']', ',', '.', '@', '%2B', '&#43;', '\\', '-', '_', '\u200b', '\u0600', '\u2011', '\u2215', '\uff53', '\u3002', '\u2800', '\u0301', '\u00e9', '*', '**', 'review-x.mjs'];
const fuzz = r => {
  let s = ''; const n = 1 + Math.floor(r() * 9);
  for (let i = 0; i < n; i++) s += FRAGS[Math.floor(r() * FRAGS.length)];
  return s;
};

describe('P2 monotonic against the old matcher (test-only oracle)', () => {
  // No exemptions: every candidate the oracle matched on (the nested sub-paths via the anchors argument, the raw
  // report, the digits of a line suffix) is still a candidate, so anything it protected stays protected.
  const clean = PATTERNS.map(oracleCleanPattern);
  const check = file => {
    if (!oracleMatchesSome(file, PATTERNS) || protects(file)) return;
    const news = lower(canonicalPaths(file, ANCHORS));
    const old = oraclePathCandidates(file, oracleAnchorsOf(clean));
    expect(old, 'oracle refused but grammar accepted ' + JSON.stringify(file)).not.toBeNull();
    for (const c of lower(old)) {
      if (clean.some(p => oracleMatchesPath(c, p))&& !news.includes(c)) throw new Error('lost match on ' + JSON.stringify(c) + ' for ' + JSON.stringify(file));
    }
  };
  it('every corpus-style shape stays protected', () => {
    for (const f of ['scripts/lib/x.mjs', '"scripts/lib/x.mjs":4', '+++ b/.claude/x', 'a/custom/y.mjs', '"custom/x"#L3-L4', 'docs/a.md']) {
      expect(oracleMatchesSome(f, PATTERNS)).toBe(true);
      expect(protects(f)).toBe(true);
    }
  });
  it('anchored sub-paths are cut before ".." resolves (round-2 audit finding)', () => {
    const pats = ['scripts/**', 'guard-*.mjs'];
    const anchors = oracleAnchorsOf(pats.map(oracleCleanPattern));
    expect(oracleMatchesSome('repo/scripts/../guard-x.mjs', pats)).toBe(true);
    expect(canonicalPaths('repo/scripts/../guard-x.mjs', anchors)).toContain('guard-x.mjs');
    expect(canonicalPaths('repo/scripts/../guard-x.mjs', anchors).some(c => globOk(c, 'guard-*.mjs'))).toBe(true);
  });
  it('audit findings: candidate bound fails closed; line digits and the raw report stay candidates', () => {
    const pats = ['scripts/secret.mjs'];
    const anchors = oracleAnchorsOf(pats.map(oracleCleanPattern));
    const many = 'scripts/'.repeat(34) + 'x.mjs';
    expect(oracleMatchesSome(many, pats)).toBe(true);
    expect(canonicalPaths(many, anchors)).toBeNull();
    expect(canonicalPaths('custom/x.mjs:42')).toContain('42');
    expect(canonicalPaths('public/readme.md#L42')).toContain('L42');
    expect(canonicalPaths('public/readme.md:42-50')).toContain('42-50');
    expect(canonicalPaths('"custom/x.mjs":42')).toContain('"custom/x.mjs":42');
  });
  it('5000 seeded fuzz strings: nothing the oracle protected is lost', () => {
    const r = rng(0x6381);
    for (let i = 0; i < 5000; i++) check(fuzz(r));
  });
  it('5000 more fuzz strings built around protected names', () => {
    const r = rng(0x5eed);
    const names = ['guard-q.mjs', 'scripts/guard-bash.mjs', 'scripts/lib/a.mjs', '.claude/s.json', 'custom/q/r.mjs', 'review-x.mjs', 'docs/a.md'];
    for (let i = 0; i < 5000; i++) check(fuzz(r) + names[Math.floor(r() * names.length)] + fuzz(r));
  });
  it('folder above the repo: without anchors a nested path, with anchors the anchored sub-path too', () => {
    expect(oracleMatchesSome('repo/scripts/guard-bash.mjs', ['scripts/guard-bash.mjs'])).toBe(true);
    expect(canonicalPaths('repo/scripts/guard-bash.mjs')).toEqual(['repo/scripts/guard-bash.mjs']);
    expect(canonicalPaths('repo/scripts/guard-bash.mjs', ANCHORS)).toEqual(['repo/scripts/guard-bash.mjs', 'scripts/guard-bash.mjs']);
  });
});

describe('P3 every tracked path canonicalises to itself first', () => {
  it('git ls-files', () => {
    const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 1 << 28 }).split('\0').filter(Boolean);
    expect(files.length).toBeGreaterThan(100);
    // The first candidate is the path as reported; any others are the edge-trimmed forms (`.claude/x` also reads `claude/x`).
    const bad = files.filter(f => { const c = canonicalPaths(f); return !(c && c[0] === f && c.length <= 3); });
    expect(bad.slice(0, 10)).toEqual([]);
  });
});

describe('P4 total and bounded', () => {
  it('never throws, always null or a short list, on hostile input', () => {
    const r = rng(7);
    const hostile = ['"'.repeat(5000), '/'.repeat(5000), 'a/'.repeat(300), '.'.repeat(2000), 'a'.repeat(511) + ':1', '\u0000', 'a'.repeat(100000) + '!', ' '.repeat(100000) + 'a', 'a:'.repeat(20000), '../'.repeat(2000) + 'x', null, undefined, {}, [], true];
    for (let i = 0; i < 2000; i++) hostile.push(fuzz(r).repeat(1 + Math.floor(r() * 80)));
    const t0 = performance.now();
    for (const h of hostile) {
      const c = canonicalPaths(h);
      expect(c === null || (Array.isArray(c) && c.length >= 1 && c.length <= 8)).toBe(true);
    }
    expect(performance.now() - t0).toBeLessThan(2000);
  });
  it('a pathological run near the bound is linear, not backtracking', () => {
    const t0 = performance.now();
    canonicalPaths('a-'.repeat(250) + '!');
    canonicalPaths('"' + 'a.'.repeat(250));
    expect(performance.now() - t0).toBeLessThan(100);
  });
});
