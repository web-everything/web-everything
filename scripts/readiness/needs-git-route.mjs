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
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
const PAREN_KEYWORD = new Set(['if', 'while', 'for', 'with']);
const MAX_WORD = 12; // longest keyword we compare against; longer identifiers are never sliced
const MAX_TEMPLATE_DEPTH = 32;
const isIdent = (c) => /[\w$\u0080-￿]/.test(c);
// ECMAScript line terminators: a line comment / unterminated string ends at any of them, not only \n.
const isNewline = (c) => c === '\n' || c === '\r' || c === ' ' || c === ' ';

function quotedEnd(t, i) {
  const n = t.length;
  const q = t[i];
  let j = i + 1;
  while (j < n && t[j] !== q && !isNewline(t[j])) j += t[j] === '\\' ? 2 : 1;
  return t[j] === q ? j + 1 : Math.min(j, n);
}
// Index just past the template literal starting at t[i] (a backtick); `${ … }` holes are parsed so a backtick
// or quote inside one cannot desynchronise the scan.
function templateEnd(t, i, depth) {
  const n = t.length;
  let j = i + 1;
  while (j < n) {
    const c = t[j];
    if (c === '\\') { j += 2; continue; }
    if (c === '`') return j + 1;
    if (c === '$' && t[j + 1] === '{' && depth < MAX_TEMPLATE_DEPTH) { j = holeEnd(t, j + 2, depth + 1); continue; }
    j++;
  }
  return n;
}
// End index (exclusive) of a regex literal starting at t[i] === '/', or -1 when there is no closing `/` on the line.
function regexEnd(t, i) {
  const n = t.length;
  let j = i + 1;
  let cls = false;
  while (j < n && !isNewline(t[j])) {
    const e = t[j];
    if (e === '\\') { j += 2; continue; }
    if (e === '[') cls = true; else if (e === ']') cls = false; else if (e === '/' && !cls) break;
    j++;
  }
  if (t[j] !== '/') return -Math.min(j, n) - 2; // not closed: the scan stopped at -(result + 2)
  j++;
  while (j < n && isIdent(t[j])) j++;
  return j;
}
// Does a `{` after this token open an object literal / expression (so its `}` is an operand and a following `/`
// divides) rather than a block (whose `}` ends a statement, so a following `/` starts a regex)? An arrow body
// (`=> {`), a `)` head (`if (x) {`, `function f() {`), a statement start and a class/else/do body are blocks.
const EXPR_BRACE_AFTER = '=(,:[?!&|+-*%<>~^';
function braceOpensExpr(last, prev, word) {
  if (last === '') return false;
  if (isIdent(last)) return REGEX_AFTER_WORD.has(word) && word !== 'else' && word !== 'do';
  if (last === '>' && prev === '=') return false;
  return EXPR_BRACE_AFTER.includes(last);
}
function holeEnd(t, i, depth) {
  const n = t.length;
  let j = i;
  const braces = []; // per open `{`: does it open an expression (object literal)?
  let exprClose = false; // the last token was the `}` of such a brace
  let last = '('; // last significant character, to tell a regex literal from a division; a hole starts an expression
  let prev = '';
  let wordStart = 0;
  let wordDot = false; // the current word is a property name (`x.in`), never a keyword
  let noCloseUntil = -1;
  while (j < n) {
    const c = t[j];
    if (c === '`') { j = templateEnd(t, j, depth); last = c; continue; }
    if (c === "'" || c === '"') { j = quotedEnd(t, j); last = c; continue; }
    if (c === '/' && t[j + 1] === '/') { while (j < n && !isNewline(t[j])) j++; continue; }
    if (c === '/' && t[j + 1] === '*') { const e = t.indexOf('*/', j + 2); j = e < 0 ? n : e + 2; continue; }
    if (c === '/') {
      const w = isIdent(last) && !wordDot && j - wordStart <= MAX_WORD ? t.slice(wordStart, j).trimEnd() : '';
      const regexOk = j >= noCloseUntil && (last === '' || (isIdent(last) ? REGEX_AFTER_WORD.has(w)
        : last === '}' ? !exprClose : !')]\'"`'.includes(last)));
      const e = regexOk ? regexEnd(t, j) : 0;
      if (e > 0) { j = e; prev = last; last = '0'; exprClose = false; wordStart = j; continue; }
      if (e < 0) noCloseUntil = -e - 2; // no closing `/` before here: later `/` on this line are divisions (no rescans)
      prev = last; last = c; exprClose = false; j++; continue;
    }
    let closesExpr = false;
    if (c === '{') braces.push(braceOpensExpr(last, prev, isIdent(last) && !wordDot && j - wordStart <= MAX_WORD ? t.slice(wordStart, j).trimEnd() : ''));
    else if (c === '}') { if (braces.length === 0) return j + 1; closesExpr = braces.pop(); }
    if (!/\s/.test(c)) {
      if (isIdent(c) && !isIdent(last)) { wordStart = j; wordDot = last === '.'; }
      prev = last;
      last = c;
      exprClose = closesExpr;
    }
    j++;
  }
  return n;
}

export function stripComments(t) {
  const n = t.length;
  let out = '';
  let i = 0;
  let last = ''; // last significant (non-space) code character
  let prev = ''; // the one before it (to tell postfix `++ /` from binary `+ /`)
  let wordStart = 0;
  let wordEnd = 0; // the identifier that ends at `last` is t[wordStart, wordEnd)
  const stack = []; // per open `(`: was it the head of if/while/for/with (a `)` there is followed by a statement)
  let ctrlParen = false; // the last token was the `)` closing such a head
  let noCloseUntil = -1; // a regex scan already found no closing `/` before this index: don't rescan the line
  let wordDot = false; // the current word is a property name (`x.in`, `x.with(...)`), never a keyword
  const word = () => (isIdent(last) && !wordDot && wordEnd - wordStart <= MAX_WORD ? t.slice(wordStart, wordEnd) : '');
  const braces = []; // per open `{`: does it open an expression (object literal)? see braceOpensExpr
  let exprClose = false; // the last token was the `}` of such a brace: an operand, so a following `/` divides
  let postfixBang = false; // the last token was a TypeScript non-null `x!`: an operand, so a following `/` divides
  const emit = (s, sig) => { out += s; prev = last; last = sig; ctrlParen = false; exprClose = false; postfixBang = false; };
  while (i < n) {
    const c = t[i];
    const d = t[i + 1];
    if (c === '/' && d === '/') { while (i < n && !isNewline(t[i])) i++; out += ' '; continue; }
    if (c === '/' && d === '*') { const j = t.indexOf('*/', i + 2); i = j < 0 ? n : j + 2; out += ' '; continue; }
    if (c === "'" || c === '"' || c === '`') {
      const end = c === '`' ? templateEnd(t, i, 0) : quotedEnd(t, i);
      emit(t.slice(i, end), c);
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
      if (!(isIdent(last) && wordEnd === i)) { wordStart = i; wordDot = last === '.'; }
      wordEnd = i + 1;
      emit(c, c);
      i++;
      continue;
    }
    if (c === '(') stack.push(PAREN_KEYWORD.has(word()));
    const opensExpr = c === '{' ? braceOpensExpr(last, prev, word()) : false;
    const nonNull = c === '!' && ((isIdent(last) && !REGEX_AFTER_WORD.has(word())) || (last === ')' && !ctrlParen) || last === ']');
    emit(c, c);
    if (c === '!') postfixBang = nonNull;
    if (c === '{') braces.push(opensExpr);
    if (c === '}') exprClose = braces.pop() ?? false;
    if (c === ')') ctrlParen = stack.pop() ?? false;
    i++;
  }
  return out;
}
// A test spawns git when it reaches child_process (any import form or alias) AND names git as an executable:
// a quoted git / git-path literal or a shell string starting with git. Mocked spawns without a child_process
// import, comments and prose are not flagged. A declared helper matches an import specifier by suffix (so
// `my-git-helper.mjs` matches `git-helper.mjs`); a specifier built at run time cannot be seen statically.
const CHILD = /\b(?:node:)?child_process\b/;
const GIT_LITERAL = /(['"`])(?:[^'"`\n]*\/)?git(?:\s[^'"`\n]*)?\1|(['"`])git\s/;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function sourceNeedsGit(text, { helpers = [] } = {}) {
  if (typeof text !== 'string' || !text || text.length > MAX_BYTES) return false;
  const code = stripComments(text);
  if (CHILD.test(code) && GIT_LITERAL.test(code)) return true;
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
