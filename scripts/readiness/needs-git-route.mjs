// Routes test files that spawn git to local execution: Forge's synced copy has no .git, so such tests fail there
// ("fatal: not a git repository") and turn verify red for unrelated PRs. Pure and side-effect free; the caller
// supplies readFile. Wiring into heavy-admission's decideRemote is a separate one-line follow-up.
import { readFileSync, statSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export const NEEDS_GIT_REASON = 'needs-git';
const MAX_BYTES = 1024 * 1024;

// String-aware: quoted/template literals are kept verbatim, only real comments are dropped. A single linear scan
// (no regex backtracking, no unbounded rescans) that also recognises regex literals, so the `//` inside
// /https?:\/\// is not mistaken for a line comment. Regex literals become a neutral token: they are not code.
// One scanner serves both the top level and every `${ … }` template hole, so the two cannot drift apart.
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
const PAREN_KEYWORD = new Set(['if', 'while', 'for', 'with']);
const MAX_WORD = 12; // longest keyword we compare against; longer identifiers are never sliced
const MAX_TEMPLATE_DEPTH = 32;
const isIdent = (c) => /[\w$\u0080-￿]/.test(c);
// ECMAScript line terminators: a line comment / regex literal ends at any of them, not only \n.
const isNewline = (c) => c === '\n' || c === '\r' || c === ' ' || c === ' ';
// A string literal may contain U+2028 / U+2029 (ES2019); only CR and LF end an unterminated one.
const isStringNewline = (c) => c === '\n' || c === '\r';

// Index of the first character at or after i that is not whitespace or part of a comment.
function skipTrivia(t, i) {
  const n = t.length;
  for (;;) {
    while (i < n && /\s/.test(t[i])) i++;
    if (t[i] === '/' && t[i + 1] === '/') { while (i < n && !isNewline(t[i])) i++; continue; }
    if (t[i] === '/' && t[i + 1] === '*') { const j = t.indexOf('*/', i + 2); if (j < 0) return n; i = j + 2; continue; }
    return i;
  }
}

function quotedEnd(t, i) {
  const n = t.length;
  const q = t[i];
  let j = i + 1;
  while (j < n && t[j] !== q && !isStringNewline(t[j])) {
    if (t[j] === '\\') j += t[j + 1] === '\r' && t[j + 2] === '\n' ? 3 : 2; // `\` + CRLF is one line continuation
    else j++;
  }
  return t[j] === q ? j + 1 : Math.min(j, n);
}
// Index just past the template literal starting at t[i] (a backtick); `${ … }` holes are parsed so a backtick
// or quote inside one cannot desynchronise the scan.
// The literal text between holes is pushed on `lits` as disjoint pieces (nested literals are pushed by the hole
// scan), so the pieces together never exceed the input size however deeply templates nest.
function templateEnd(t, i, depth, lits) {
  const n = t.length;
  let j = i + 1;
  let piece = j;
  while (j < n) {
    const c = t[j];
    if (c === '\\') { j += 2; continue; }
    if (c === '`') { if (lits) lits.push(t.slice(piece, j)); return j + 1; }
    if (c === '$' && t[j + 1] === '{' && depth < MAX_TEMPLATE_DEPTH) {
      if (lits) lits.push(t.slice(piece, j));
      j = scan(t, j + 2, depth + 1, true, lits).end;
      piece = j;
      continue;
    }
    j++;
  }
  if (lits) lits.push(t.slice(piece, Math.min(j, n)));
  return n;
}
// Does a `{` after this token open an object literal / expression (so its `}` is an operand and a following `/`
// divides) rather than a block (whose `}` ends a statement, so a following `/` starts a regex)? An arrow body
// (`=> {`), a `)` head (`if (x) {`, `function f() {`), a statement start and a class/else/do body are blocks.
// (A function / class EXPRESSION body is an expression too: scan() tracks that separately.)
const EXPR_BRACE_AFTER = '=(,:[?!&|+-*%<>~^';
function braceOpensExpr(last, prev, word) {
  if (last === '') return false;
  if (isIdent(last)) return REGEX_AFTER_WORD.has(word) && word !== 'else' && word !== 'do';
  if (last === '>' && prev === '=') return false;
  return EXPR_BRACE_AFTER.includes(last);
}
// Is a `function` / `class` / `async` keyword starting after this token in expression position (so its body's `}`
// is an operand) rather than a declaration (statement start, ASI after a value, `export`, `else`)?
function exprStart(last, prev, word) {
  if (last === '') return false;
  if (isIdent(last)) return REGEX_AFTER_WORD.has(word) && word !== 'else' && word !== 'do';
  if ((last === '+' || last === '-') && prev === last) return false; // postfix `x++` then a new statement
  return !';{})]\'"`'.includes(last);
}

// Scans t from `start`. At the top level (inHole false) it runs to the end; inside a `${ … }` hole it stops just past
// the matching `}`. Returns the comment-stripped text and the index where the scan stopped. String / template
// literal contents (without their delimiters) are pushed on `lits` when given.
function scan(t, start, depth, inHole, lits) {
  const n = t.length;
  let out = '';
  let i = start;
  let last = inHole ? '(' : ''; // last significant (non-space) code character; a hole starts an expression
  let prev = ''; // the one before it (to tell postfix `++ /` from binary `+ /`)
  let wordStart = 0;
  let wordEnd = 0; // the identifier that ends at `last` is t[wordStart, wordEnd)
  const stack = []; // per open `(`: 1 = head of if/while/for/with, 2 = params of a function expression, 3 = of a declaration
  let ctrlParen = false; // the last token was the `)` closing a control head
  let fnBodyExpr = false; // the last token was the `)` closing the params of a function expression
  let noCloseUntil = -1; // a regex scan already found no closing `/` before this index: don't rescan the line
  let wordDot = false; // the current word is a property name (`x.in`, `x.with(...)`), never a keyword
  const word = () => (isIdent(last) && !wordDot && wordEnd - wordStart <= MAX_WORD ? t.slice(wordStart, wordEnd) : '');
  const braces = []; // per open `{`: does it open an expression (object literal / function or class expression body)?
  let exprClose = false; // the last token was the `}` of such a brace: an operand, so a following `/` divides
  let postfixBang = false; // the last token was a TypeScript non-null `x!`: an operand, so a following `/` divides
  let numDot = false; // the last token was the `.` ending a numeric literal (`1.`): an operand, so a following `/` divides
  let prevWordFor = false; // the current word directly follows the word `for` (comments and spaces between don't count)
  let asyncExpr = false; // the last `async` keyword began in expression position
  let pendKind = ''; // 'function' | 'class' keyword seen, its body `{` not yet opened
  let pendExpr = false; // ... and it began in expression position
  let pendDepth = 0; // ... at this paren depth
  const emit = (s, sig) => { out += s; prev = last; last = sig; ctrlParen = false; exprClose = false; postfixBang = false; fnBodyExpr = false; numDot = false; };
  while (i < n) {
    const c = t[i];
    const d = t[i + 1];
    if (c === '/' && d === '/') { while (i < n && !isNewline(t[i])) i++; out += ' '; continue; }
    if (c === '/' && d === '*') { const j = t.indexOf('*/', i + 2); i = j < 0 ? n : j + 2; out += ' '; continue; }
    if (c === "'" || c === '"' || c === '`') {
      const end = c === '`' ? templateEnd(t, i, depth, lits) : quotedEnd(t, i);
      emit(t.slice(i, end), c);
      if (lits && c !== '`') lits.push(t.slice(i + 1, end > i + 1 && t[end - 1] === c ? end - 1 : end));
      i = end;
      continue;
    }
    if (c === '/') {
      let regexOk;
      if (i < noCloseUntil) regexOk = false;
      else if (last === '') regexOk = true;
      else if (isIdent(last)) regexOk = REGEX_AFTER_WORD.has(word());
      else if (last === ')') regexOk = ctrlParen;
      else if (last === ']' || last === '"' || last === "'" || last === '`') regexOk = false;
      else if ((last === '+' || last === '-') && prev === last) regexOk = false; // postfix ++ / --
      else if (last === '!') regexOk = !postfixBang;
      else if (last === '.') regexOk = !numDot; // `1. / 2` divides; a spread `.../re/` or stray dot starts a regex
      else if (last === '}') regexOk = !exprClose; // end of a block starts a statement; end of an object literal is an operand
      else regexOk = true; // operator, `(`, `,`, `=`, `{`, `;`
      if (regexOk) {
        let j = i + 1;
        let cls = false;
        while (j < n && !isNewline(t[j])) {
          const e = t[j];
          if (e === '\\') { j += 2; continue; }
          if (e === '[') cls = true; else if (e === ']') cls = false; else if (e === '/' && !cls) break;
          j++;
        }
        if (t[j] === '/') {
          j++;
          while (j < n && isIdent(t[j])) j++;
          emit(' 0 ', '0');
          wordStart = wordEnd = 0; // `0` is a number, never a keyword
          i = j;
          continue;
        }
        noCloseUntil = Math.min(j, n); // no closing `/` on this line: later `/` here are divisions
      }
    }
    if (/\s/.test(c)) { out += c; i++; continue; }
    if (isIdent(c)) {
      if (!(isIdent(last) && wordEnd === i)) {
        const dot = last === '.';
        if (!dot) {
          let e = i;
          while (e < n && e - i <= MAX_WORD && isIdent(t[e])) e++;
          const w = e - i <= MAX_WORD ? t.slice(i, e) : '';
          // a keyword used as a property name (`{class: 1}`, `{function: x}`) is followed by `:` / `,` / `}`, not a body
          // (whitespace and comments may sit between the keyword and what follows it)
          const nx = w === 'function' || w === 'class' ? t[skipTrivia(t, e)] ?? '' : '';
          const keyword = w === 'function' ? nx === '(' || nx === '*' || isIdent(nx) : w === 'class' ? nx === '{' || isIdent(nx) : w === 'async';
          if (keyword) {
            let ex = exprStart(last, prev, word());
            if (w === 'function' && isIdent(last) && word() === 'async') ex = asyncExpr; // `async function`: the async decides
            if (w === 'async') asyncExpr = ex;
            else { pendKind = w; pendExpr = ex; pendDepth = stack.length; }
          }
        }
        prevWordFor = isIdent(last) && word() === 'for'; // `for await (` is a control head like `for (`
        wordStart = i;
        wordDot = dot;
      }
      wordEnd = i + 1;
      emit(c, c);
      i++;
      continue;
    }
    if (c === '(') {
      const head = word();
      let kind = PAREN_KEYWORD.has(head) || (head === 'await' && prevWordFor) ? 1 : 0;
      if (!kind && pendKind === 'function' && stack.length === pendDepth) kind = pendExpr ? 2 : 3;
      stack.push(kind);
    }
    let opensExpr = false;
    if (c === '{') {
      opensExpr = braceOpensExpr(last, prev, word());
      if (last === ')' && fnBodyExpr) opensExpr = true;
      if (pendKind && stack.length === pendDepth) {
        if (pendKind === 'function' && last === ')') pendKind = '';
        else if (pendKind === 'class' && (isIdent(last) || last === ')')) { opensExpr = pendExpr; pendKind = ''; }
      }
    }
    if (c === '}' && inHole && braces.length === 0) return { out, end: i + 1 };
    if (c === ';') pendKind = '';
    const nonNull = c === '!' && ((isIdent(last) && !REGEX_AFTER_WORD.has(word())) || (last === ')' && !ctrlParen) || last === ']');
    const endsNumber = c === '.' && isIdent(last) && !wordDot && wordEnd === i && t[wordStart] >= '0' && t[wordStart] <= '9';
    emit(c, c);
    if (c === '!') postfixBang = nonNull;
    if (c === '.') numDot = endsNumber;
    if (c === '{') braces.push(opensExpr);
    if (c === '}') exprClose = braces.pop() ?? false;
    if (c === ')') {
      const k = stack.pop() ?? 0;
      ctrlParen = k === 1;
      fnBodyExpr = k === 2;
      if (stack.length < pendDepth) pendKind = ''; // the group holding a pending keyword closed without a body
    }
    i++;
  }
  return { out, end: n };
}

// The source with comments removed, plus the contents of every string / template literal (nested ones included).
export function scanSource(t) {
  const literals = [];
  return { code: scan(t, 0, 0, false, literals).out, literals };
}
export function stripComments(t) {
  return scan(t, 0, 0, false, null).out;
}

// A test spawns git when it reaches child_process (any import form or alias) AND names git as an executable:
// a string whose command text (the start of the string, or after `;` `&` `|` `(` a backtick or a line break) is
// `git`, a path ending in `/git`, optionally behind `VAR=value` prefixes and whitespace, followed by a space or
// the end. Mocked spawns without a child_process import, comments and prose are not flagged. A declared helper
// matches an import specifier by suffix (so `my-git-helper.mjs` matches `git-helper.mjs`); a specifier built at
// run time cannot be seen statically.
const CHILD = /\b(?:node:)?child_process\b/;
// the class ends with the literal U+2028 and U+2029 characters (line terminators, written raw so a regex literal stays valid)
const COMMAND_SEPARATOR = new RegExp('[;&|(`' + String.raw`\n\r  ]`);
const WS = /\s*/y;
const ENV_ASSIGN = /[A-Za-z_]\w*=(?:"[^"\n]*"|'[^'\n]*'|\S*)\s+/y;
const TOKEN = /\S+/y;
const GIT_AT = /(?:[^\n]*\/)?git(?:\.exe)?(?=\s|$)/y;
// Words that run the next word as a command (shell keywords, groups, wrappers); skipped before looking for `git`.
const COMMAND_PREFIX = new Set(['then', 'else', 'elif', 'do', 'if', 'while', 'until', '!', '{', 'sudo', 'time', 'exec', 'env', 'command', 'nice', 'nohup', 'xargs', 'builtin',
  'timeout', 'setsid', 'stdbuf', 'ionice', 'caffeinate', 'doas', 'xcrun', 'arch']);
// A shell run with `-c` takes the rest of the segment as a command line of its own.
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
const SHELL_C_FLAG = /^-[A-Za-z]*c[A-Za-z]*$/;
const DURATION = /^\d[\d.]*[smhd]?$/; // `timeout 5 git`, `timeout -k 1 5 git`
const MAX_SHELL_DEPTH = 3;
const baseName = (tok) => tok.slice(tok.lastIndexOf('/') + 1);
// The text a JS string literal evaluates to: `\n` `\t` `\xHH` `\uHHHH` `\u{…}` and the other escapes are decoded in one
// pass (so `\\n` stays a backslash and an `n`); a `\` + line break is a continuation and vanishes.
const JS_ESCAPE = /\\(?:x([0-9a-fA-F]{2})|u\{([0-9a-fA-F]{1,6})\}|u([0-9a-fA-F]{4})|(\r\n|[\s\S]))/g;
const SIMPLE_ESCAPE = { n: '\n', r: '\r', t: '\t', b: '\b', v: '\v', f: '\f', 0: '\0' };
function decodeEscapes(s) {
  return s.replace(JS_ESCAPE, (all, x, ub, u4, ch) => {
    if (x ?? u4) return String.fromCharCode(parseInt(x ?? u4, 16));
    if (ub) { const cp = parseInt(ub, 16); return cp <= 0x10ffff ? String.fromCodePoint(cp) : all; }
    if (ch === '\r\n' || ch === '\n' || ch === '\r' || ch === ' ' || ch === ' ') return '';
    return SIMPLE_ESCAPE[ch] ?? ch;
  });
}
const GIT_TOKEN = /^(?:\S*\/)?git(?:\.exe)?$/;
// Walks the command word of one segment. A work list over (position, behind-a-wrapper) states, each visited once, keeps it
// linear however many `A=b` prefixes, wrappers or flags there are. Behind a wrapper (`sudo`, `env`, `nice`, `command`, a
// shell keyword …) an option (`-i`, `--`) is skipped, and so is the value that may follow it (`env -u X git`, `nice -n 5 git`).
// A `sh -c '…'` met on the way pushes its command line on `subs` (the first only: bounded work) for the caller to judge.
function commandIsGit(segment, subs) {
  const seen = new Set();
  const todo = [[0, false]];
  while (todo.length) {
    const [from, wrapped] = todo.pop();
    WS.lastIndex = from;
    WS.test(segment);
    const pos = WS.lastIndex;
    const key = pos * 2 + (wrapped ? 1 : 0);
    if (seen.has(key)) continue;
    seen.add(key);
    ENV_ASSIGN.lastIndex = pos;
    if (ENV_ASSIGN.test(segment)) { todo.push([ENV_ASSIGN.lastIndex, wrapped]); continue; }
    TOKEN.lastIndex = pos;
    const m = TOKEN.exec(segment);
    if (!m) continue;
    const tok = m[0];
    const end = pos + tok.length;
    const base = baseName(tok);
    if (COMMAND_PREFIX.has(tok) || COMMAND_PREFIX.has(base)) { todo.push([end, true]); continue; }
    if (SHELLS.has(base) && subs.length === 0) {
      let p = end;
      for (;;) {
        WS.lastIndex = p;
        WS.test(segment);
        TOKEN.lastIndex = WS.lastIndex;
        const o = TOKEN.exec(segment);
        if (!o || o[0][0] !== '-') break;
        p = WS.lastIndex + o[0].length;
        if (SHELL_C_FLAG.test(o[0])) { WS.lastIndex = p; WS.test(segment); subs.push(segment.slice(WS.lastIndex)); break; }
      }
    }
    if (wrapped && DURATION.test(tok)) { todo.push([end, true]); continue; }
    if (wrapped && tok[0] === '-') {
      todo.push([end, true]);
      WS.lastIndex = end;
      WS.test(segment);
      TOKEN.lastIndex = WS.lastIndex;
      const v = TOKEN.exec(segment);
      if (v) todo.push([WS.lastIndex + v[0].length, true]);
      continue;
    }
    if (wrapped) { if (GIT_TOKEN.test(tok)) return true; continue; }
    GIT_AT.lastIndex = pos;
    if (GIT_AT.test(segment)) return true;
  }
  return false;
}
// The shell removes quotes and backslashes from a command word (`"git"`, `'git'`, `g"i"t`, `\git`), reads `$'…'` / `$"…"`
// like a plain quote and decodes `\xHH` / `\NNN` inside `$'…'`, so a segment that has any is also judged with all that
// applied. (Dropping them can only add matches, never hide one.)
const SHELL_QUOTING = /["'\\]/;
const dequote = (s) => s
  .replace(/\\x([0-9a-fA-F]{1,2})|\\u([0-9a-fA-F]{4})|\\([0-7]{3})/g, (_, h, u, o) => String.fromCharCode(h ? parseInt(h, 16) : u ? parseInt(u, 16) : parseInt(o, 8)))
  .replace(/\$(?=["'])/g, '')
  .replace(/["'\\]/g, '');
// Judges one segment, and the command line of a `sh -c '…'` in it (at most MAX_SHELL_DEPTH levels deep, one per level).
function segmentRunsGit(seg, depth) {
  for (const text of SHELL_QUOTING.test(seg) ? [seg, dequote(seg)] : [seg]) {
    const subs = [];
    if (commandIsGit(text, subs)) return true;
    if (depth < MAX_SHELL_DEPTH && subs.some(s => namesGit(s, depth + 1))) return true;
  }
  return false;
}
// `)` also ends a command (`FOO=$(echo a) git status`, `(cd x) git`): over-matching it only routes locally.
const namesGit = (decoded, depth) => decoded.split(COMMAND_SEPARATOR).flatMap(p => p.split(')')).some(seg => segmentRunsGit(seg, depth));
const literalNamesGit = (s) => namesGit(decodeEscapes(s), 0);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function sourceNeedsGit(text, { helpers = [] } = {}) {
  if (typeof text !== 'string' || !text || text.length > MAX_BYTES) return false;
  const { code, literals } = scanSource(text);
  if (CHILD.test(code) && literals.some(literalNamesGit)) return true;
  // Every import form: static (`from '…'`), side-effect (`import '…'`), dynamic (`import('…')`), `require('…')`,
  // `require.resolve('…')` and `vi.importActual('…')`; an optional `?query`/`#hash` may follow the file name.
  // Each alternative has one `\s*` per gap (no adjacent `\s*\s*`), so a long whitespace run cannot backtrack quadratically.
  return (Array.isArray(helpers) ? helpers : []).some(h => typeof h === 'string' && h !== '' && new RegExp(
    `(?:\\bfrom\\s*|\\bimport\\s*(?:\\(\\s*)?|\\brequire(?:\\.resolve)?\\s*\\(\\s*|\\b(?:vi|jest)\\.(?:importActual|requireActual)\\s*\\(\\s*)['"\`][^'"\`\\n]*${escapeRe(h)}(?:[?#][^'"\`\\n]*)?['"\`]`,
  ).test(code));
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

// Only filters naming a readable test file are judged; directory, glob, substring and unfiltered selections are
// unresolved and stay remote (no over-routing). The wiring follow-up should expand them via forge-test-selection.
export function routeNeedsGit({ argv, cwd = process.cwd(), readFile, declared = [], helpers = [] } = {}) {
  const read = readFile ?? containedRead(cwd);
  const hits = [];
  for (const file of testFilterArgs(argv)) {
    if (declared.includes(file)) { hits.push(file); continue; }
    try { if (sourceNeedsGit(read(file), { helpers })) hits.push(file); } catch { /* unresolved: stay remote */ }
  }
  return hits.length ? { local: true, reason: NEEDS_GIT_REASON, files: hits } : { local: false };
}
