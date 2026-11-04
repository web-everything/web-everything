// Routes test files that spawn git to local execution: Forge's synced copy has no .git, so such tests fail there
// ("fatal: not a git repository") and turn verify red for unrelated PRs. Pure and side-effect free; the caller
// supplies readFile. Wiring into heavy-admission's decideRemote is a separate one-line follow-up.
import { readFileSync, statSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export const NEEDS_GIT_REASON = 'needs-git';
const MAX_BYTES = 1024 * 1024;

// String-aware: quoted/template literals are kept verbatim, only real comments are dropped.
// A single linear scan (no regex backtracking) that also recognises regex literals, so the `//` inside
// /https?:\/\// is not mistaken for a line comment. Regex literals are replaced by a neutral token: they are not code.
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
const isIdent = (c) => /[\w$]/.test(c);
function stripComments(t) {
  const n = t.length;
  let out = '';
  let i = 0;
  let last = ''; // last significant (non-space) code character emitted
  let word = ''; // identifier that ends at `last`, if any
  const emit = (s, sig) => { out += s; last = sig; word = ''; };
  while (i < n) {
    const c = t[i];
    const d = t[i + 1];
    if (c === '/' && d === '/') { while (i < n && t[i] !== '\n') i++; out += ' '; continue; }
    if (c === '/' && d === '*') { const j = t.indexOf('*/', i + 2); i = j < 0 ? n : j + 2; out += ' '; continue; }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < n && t[j] !== c && (c === '`' || t[j] !== '\n')) j += t[j] === '\\' ? 2 : 1;
      const end = t[j] === c ? j + 1 : Math.min(j, n);
      emit(t.slice(i, end), c);
      i = end;
      continue;
    }
    if (c === '/') {
      const regexOk = last === '' || (isIdent(last) ? REGEX_AFTER_WORD.has(word) : !')]}'.includes(last) && last !== '"' && last !== "'" && last !== '`');
      if (regexOk) {
        let j = i + 1;
        let cls = false;
        while (j < n && t[j] !== '\n') {
          const e = t[j];
          if (e === '\\') { j += 2; continue; }
          if (e === '[') cls = true; else if (e === ']') cls = false; else if (e === '/' && !cls) break;
          j++;
        }
        if (t[j] === '/') {
          j++;
          while (j < n && isIdent(t[j])) j++;
          emit(' 0 ', '0');
          word = '';
          i = j;
          continue;
        }
      }
    }
    if (/\s/.test(c)) { out += c; i++; continue; }
    if (isIdent(c)) { word = isIdent(last) && word !== '' && out.endsWith(word) ? word + c : c; last = c; out += c; i++; continue; }
    emit(c, c);
    i++;
  }
  return out;
}
// A test spawns git when it reaches child_process (any import form or alias) AND names git as an executable:
// a quoted git / git-path literal or a shell string starting with git. Mocked spawns without a child_process
// import, comments and prose are not flagged. A declared helper matches an import specifier by basename only.
const CHILD = /\b(?:node:)?child_process\b/;
const GIT_LITERAL = /(['"`])(?:[^'"`\n]*\/)?git(?:\s[^'"`\n]*)?\1|(['"`])git\s/;

export function sourceNeedsGit(text, { helpers = [] } = {}) {
  if (typeof text !== 'string' || !text) return false;
  const code = stripComments(text);
  if (CHILD.test(code) && GIT_LITERAL.test(code)) return true;
  // Every import form: static (`from '…'`), side-effect (`import '…'`), dynamic (`import('…')`) and `require('…')`.
  return helpers.some(h => new RegExp(`(?:\\bfrom\\s*|\\bimport\\s*\\(?\\s*|\\brequire\\s*\\(\\s*)['"\`][^'"\`\\n]*${h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]`).test(code));
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
