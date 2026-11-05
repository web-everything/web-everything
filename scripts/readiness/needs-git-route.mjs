// Routes test files that spawn git to local execution: Forge's synced copy has no .git, so such tests fail there
// ("fatal: not a git repository") and turn verify red for unrelated PRs. Pure and side-effect free; the caller
// supplies readFile. Wiring into heavy-admission's decideRemote is a separate one-line follow-up.
import { readFileSync, statSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export const NEEDS_GIT_REASON = 'needs-git';
const MAX_BYTES = 1024 * 1024;

// R90 / R559 fail-closed rule. The previous approach tried to PROVE a file does not spawn git by lexing JS by hand;
// every red-team round found another construct that hid a spawn from it. The rule is now inverted: a file is routed
// remote (no git) only if a conservative, linear check finds NO git-related token anywhere in its text. Anything
// ambiguous, unparseable, oversize or unreadable needs git and runs locally. False positives (a local run) are fine;
// false negatives are not. No lexer, no regex backtracking: one pass to compact the text, then plain indexOf calls.
// A git spawn needs a process-spawning vehicle, so the check is layered: (1) vehicle names, matched on text compacted
// so quoting / concatenation / comments cannot split them; (2) raw-text vehicles and dynamic-code escapes; (3) the word
// `git` itself (package or helper imports such as simple-git or a git helper), standalone, not inside digit/github.
const COMPACT_TOKENS = ['getownproperty', 'getprototypeof', 'setprototypeof', 'proto__', 'lookupgetter', 'lookupsetter', 'reflect', 'proxy', 'returnthis', 'dlopen', 'runinthiscontext', 'runincontext', 'getbuiltinmodule', 'createrequire', 'child_', 'child_process', 'childprocess', 'worker_threads', 'workerthreads', 'fromcharcode', 'fromcodepoint', 'simplegit', 'shelljs', 'execa', 'crossspawn'];
const RAW_TOKENS = ['globalthis', 'reflect.', 'spawn', 'process.binding', 'binding(', 'mainmodule', 'deno.command', 'new function', 'atob(', 'base64'];
// Words a token-splitting trick would need to spell (`module['requ' + 'ire']`, `globalThis['ev' + 'al']`).
const SPLIT_GUARD = ['require', 'binding', 'constructor'];
// Computed member access (`global ['ev' + 'al']`, `(function(){return this})()['x']`, `process[a + b]`) is how a
// token gets rebuilt at run time. Flag `[` right after a root object / call / index, unless it is a plain integer
// index. Looks backwards over whitespace only; the caller also runs this on comment-stripped text.
const ROOTS = new Set(['global', 'globalthis', 'self', 'window', 'this', 'process', 'module', 'require', 'reflect', 'function', 'constructor', 'eval', 'exports', 'arguments']);
function hasComputedAccess(text) {
  for (let i = text.indexOf('['); i >= 0; i = text.indexOf('[', i + 1)) {
    let j = i - 1;
    while (j >= 0 && /\s/.test(text[j])) j--;
    if (j < 0) continue;
    const c = text[j];
    // `{[k]: v} = fn` computed destructuring, and any bracket whose content builds a key (`a[x + y]`, `a[`${x}`]`, `a[f()]`).
    let close = -1;
    for (let q = i + 1; q < text.length && q <= i + 200; q++) if (text[q] === ']') { close = q; break; } // bounded: no rescans of the whole tail
    const inner = text.slice(i + 1, close < 0 || close - i > 200 ? i + 201 : close);
    if (c === '{' || c === ',') {
      // computed key in an object literal / destructuring: the `]` is followed by `:` `,` `}` or `=`
      let n = close < 0 ? -1 : close + 1;
      while (n >= 0 && n < text.length && /\s/.test(text[n])) n++;
      if (n >= 0 && (text[n] === ':' || text[n] === '}' || text[n] === '=') && !/^\s*\d+\s*$/.test(inner)) return true;
      continue;
    }
    // any non-literal computed read (`fn[key]`, `a[x + y]`) can rebuild a name at run time; only integer and plain string-literal keys are safe
    if ((c === ')' || c === ']' || c === '.' || c === '?' || c > '\u007f' || /[A-Za-z0-9_$]/.test(c)) && !/^\s*(?:\d+|'[^'+`\\$]*'|"[^"+`\\$]*")\s*$/.test(inner)) return true;
    let root = c === ')' || c === ']' || c === '}';
    if (!root && /[A-Za-z0-9_$]/.test(c)) {
      let k = j;
      while (k >= 0 && /[A-Za-z0-9_$]/.test(text[k]) && j - k < 12) k--;
      root = ROOTS.has(text.slice(k + 1, j + 1).toLowerCase()) && !/[A-Za-z0-9_$.]/.test(text[k] ?? ' ');
    }
    if (!root) continue;
    let e = i + 1;
    while (e < text.length && text[e] >= '0' && text[e] <= '9') e++;
    if (e > i + 1 && text[e] === ']') continue; // x()[0]
    return true;
  }
  return false;
}

// `x.constructor`, `x ?. constructor`, `x['constructor']`: the Function-constructor route to run-time code. A class
// `constructor(` declaration is not a member access and stays fine.
function hasConstructorAccess(low) {
  for (let i = low.indexOf('constructor'); i >= 0; i = low.indexOf('constructor', i + 11)) {
    let j = i - 1;
    while (j >= 0 && /\s/.test(low[j])) j--;
    if (j >= 0 && (low[j] === '.' || low[j] === "'" || low[j] === '"' || low[j] === '`')) return true;
    let n = i + 11; // `{ constructor: make }` destructuring / `{ constructor }` shorthand: anything but a `constructor(` declaration
    while (n < low.length && /\s/.test(low[n])) n++;
    if (low[n] !== '(') return true;
  }
  return false;
}

function countOf(hay, needle) {
  let n = 0;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}
const isLetter = (ch) => ch !== undefined && /[a-z]/i.test(ch);
const isCodeChar = (c) => (c >= 48 && c <= 57) || (c >= 97 && c <= 122) || c === 95; // 0-9 a-z _

// Lowercased text with everything except [a-z0-9_] removed, so quoting, concatenation, comments, whitespace and
// template holes cannot split a token (`'gi' + /*x*/ 't'` compacts to `git`). Returns null for unparseable text:
// control characters or U+FFFD (binary / mis-decoded input).
function compact(text) {
  const out = [];
  for (let i = 0; i < text.length; i++) {
    let c = text.charCodeAt(i);
    if (c === 0xFFFD || (c < 32 && c !== 9 && c !== 10 && c !== 13)) return null;
    if (c >= 65 && c <= 90) c += 32;
    if (isCodeChar(c)) out.push(String.fromCharCode(c));
  }
  return out.join('');
}

// Index of the first character at or after i that is not whitespace or inside a block comment (`import/**/(x)`).
// `memo` remembers the last `*/` found so many keywords inside one long comment cannot each rescan its tail.
function skipGap(text, i, memo) {
  for (;;) {
    while (i < text.length && /\s/.test(text[i])) i++;
    if (!text.startsWith('/*', i)) return i;
    const from = i + 2;
    if (!(memo.from <= from && (memo.end >= from || memo.end === -1))) { memo.from = from; memo.end = text.indexOf('*/', from); }
    if (memo.end < 0) return text.length;
    i = memo.end + 2;
  }
}

// Escapes that can spell a token (`\x67it`, `\u0067it`, octal) and computed module loads (`import(x)`, `require(x)`).
function hasObfuscation(text) {
  for (let i = text.indexOf('\\'); i >= 0; i = text.indexOf('\\', i + 1)) {
    const n = text[i + 1];
    if (n === 'x' || n === 'u' || (n >= '0' && n <= '9')) return true;
  }
  const memo = { from: Infinity, end: -2 };
  for (const kw of ['import', 'require']) {
    for (let i = text.indexOf(kw); i >= 0; i = text.indexOf(kw, i + kw.length)) {
      if (kw === 'require' && isLetter(text[i + kw.length])) continue; // prose such as `required`
      let j = skipGap(text, i + kw.length, memo);
      if (text[j] !== '(') { if (kw === 'require') return true; continue; } // `const load = require` aliases the loader
      j = skipGap(text, j + 1, memo);
      const q = text[j];
      if (q !== "'" && q !== '"' && q !== '`') return true;
      // The literal must be the whole, static argument: `import('a' + b)` and import(`${a}`) build a specifier at run time.
      const end = text.indexOf(q, j + 1);
      if (end < 0) return true;
      if (q === '`' && text.slice(j, end).includes('${')) return true;
      const k = skipGap(text, end + 1, memo);
      if (text[k] !== ')' && text[k] !== ',') return true;
    }
  }
  return false;
}

// True when `w` occurs with no letter directly before or after it (so `digit`, `github`, `evaluate` do not match).
function hasWord(low, w) {
  for (let i = low.indexOf(w); i >= 0; i = low.indexOf(w, i + 1)) {
    if (!isLetter(low[i - 1]) && !isLetter(low[i + w.length])) return true;
  }
  return false;
}

// Text with every `<open> … <close>` span removed (an unterminated span removes the rest). One forward pass.
function dropSpans(text, open, close) {
  let out = '';
  let from = 0;
  for (let i = text.indexOf(open); i >= 0; i = text.indexOf(open, from)) {
    out += text.slice(from, i) + ' ';
    const j = text.indexOf(close, i + open.length);
    if (j < 0) return out;
    from = j + close.length;
  }
  return out + text.slice(from);
}

const MAX_HELPERS = 1000; // helper matching is O(source × helpers): beyond this the config is ambiguous

export function sourceNeedsGit(text, { helpers = [] } = {}) {
  if (typeof text !== 'string' || text.length > MAX_BYTES) return true; // ambiguous: fail closed
  if (text === '') return false;
  const flat = compact(text);
  if (flat === null || hasObfuscation(text)) return true;
  // Comments can sit between the halves of a split token (`'child_' /* x */ + 'process'`), so the token check also
  // runs on text with block comments, and with block + line comments, removed. The original text is always checked
  // too: a `/*` or `//` inside a string must not be allowed to hide the code after it.
  const noBlock = dropSpans(text, '/*', '*/');
  const variants = [flat, compact(noBlock), compact(dropSpans(noBlock, '//', '\n'))];
  if (variants.some(v => v === null || COMPACT_TOKENS.some(t => v.includes(t)))) return true;
  const low = text.toLowerCase();
  if (hasConstructorAccess(low) || hasConstructorAccess(noBlock.toLowerCase())) return true;
  if (hasComputedAccess(text) || hasComputedAccess(noBlock)) return true;
  // Compaction glues split literals back together; a guard word that appears more often compacted than in the raw
  // text was spelled across quotes / operators / comments, so it is a computed access: needs git.
  if (SPLIT_GUARD.some(w => countOf(flat, w) > countOf(low, w))) return true;
  if (RAW_TOKENS.some(t => low.includes(t)) || hasWord(low, 'eval') || hasWord(low, 'global') || hasWord(low, 'vm') || hasWord(low, 'binding') || hasWord(text, 'Function') || hasWord(low, 'git')) return true;
  const list = Array.isArray(helpers) ? helpers : [];
  if (list.length > MAX_HELPERS) return true;
  return list.some(h => {
    if (typeof h !== 'string' || h === '') return false;
    const f = compact(h);
    return low.includes(h.toLowerCase()) || noBlock.toLowerCase().includes(h.toLowerCase()) || variants.some(v => f !== null && f !== '' && v.includes(f));
  });
}

// Positional (non-flag) arguments after the vitest/test:unit invocation. Values of known valued flags are skipped.
const VALUED = new Set(['--config', '-c', '--root', '-r', '--dir', '--project', '--reporter']);
export function testFilterArgs(argv) {
  if (!Array.isArray(argv)) return [];
  let rest;
  if (argv[0] === 'npm' && argv[1] === 'run' && /^test:/.test(argv[2] ?? '')) {
    const dd = argv.indexOf('--');
    rest = dd < 0 ? [] : argv.slice(dd + 1);
  } else if (argv[0] === 'vitest' && argv[1] === 'run') rest = argv.slice(2);
  else if (argv[0] === 'npx' && argv[1] === 'vitest' && argv[2] === 'run') rest = argv.slice(3);
  else return [];
  const out = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (typeof a !== 'string') continue;
    if (a.startsWith('-')) { if (VALUED.has(a)) i++; continue; }
    out.push(a);
  }
  return out;
}

// Default reader: only regular files inside cwd (symlinks resolved), at most MAX_BYTES; anything else throws.
function containedRead(cwd) {
  const root = realpathSync(cwd);
  return (p) => {
    const real = realpathSync(resolve(root, p));
    const rel = relative(root, real);
    if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error('outside-root');
    const st = statSync(real);
    if (!st.isFile() || st.size > MAX_BYTES) throw new Error('not-readable-file');
    return readFileSync(real, 'utf8');
  };
}

const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
// Filters naming a test file are judged (unreadable or oversize = needs git); directory, glob, substring and
// unfiltered selections are unresolved and stay remote. The wiring follow-up should expand them via forge-test-selection.
export function routeNeedsGit({ argv, cwd = process.cwd(), readFile, declared = [], helpers = [] } = {}) {
  const read = readFile ?? containedRead(cwd);
  const hits = [];
  for (const file of testFilterArgs(argv)) {
    if (declared.includes(file)) { hits.push(file); continue; }
    try { if (sourceNeedsGit(read(file), { helpers })) hits.push(file); } catch { if (TEST_FILE.test(file)) hits.push(file); /* unreadable test file: ambiguous, fail closed */ }
  }
  return hits.length ? { local: true, reason: NEEDS_GIT_REASON, files: hits } : { local: false };
}
