/** Shadow-only static dependencies; never used to choose a gate's tests. */
import { resolveSpecifier, isGraphSourceFile, isVitestTestFile, testDepths } from './related-test-selection.mjs';

export const MAX_INPUT_BYTES = 512 * 1024;

const SPECIFIER_RE = /\bfrom\s*['"]([^'"\n]+)['"]|\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)|\bimport\s+['"]([^'"\n]+)['"]|\b(?:require|mock|doMock|unmock|doUnmock|importActual|importMock)\s*\(\s*['"]([^'"\n]+)['"]|\bimport\s*\(\s*`([^`$\n]+)/g;

// Advance once over an opaque quoted string, respecting escaped delimiters.
function stringEnd(text, start) {
  const quote = text[start];
  let i = start + 1;
  while (i < text.length) {
    if (text[i] === '\\') { i += 2; continue; }
    if (text[i++] === quote) break;
  }
  return Math.min(i, text.length);
}

/** Linear lexical pass; preserve literals and expose uncertain slash contexts. */
export function stripCommentsWithStatus(text) {
  text = String(text ?? '');
  const chunks = [];
  let i = 0;
  let start = 0;
  let expressionStart = true;
  let ambiguous = false;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\n' || ch === '\r') { expressionStart = true; i++; continue; }
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === "'" || ch === '"' || ch === '`') {
      i = stringEnd(text, i);
      expressionStart = false;
      continue;
    }
    if (/[\w$]/.test(ch)) {
      const tokenStart = i++;
      while (i < text.length && /[\w$]/.test(text[i])) i++;
      expressionStart = text.slice(tokenStart, i) === 'return';
      continue;
    }
    if (ch !== '/') {
      expressionStart = '(,=:[!&|?{};'.includes(ch);
      i++;
      continue;
    }
    if (text[i + 1] !== '/' && text[i + 1] !== '*') {
      if (!expressionStart) { ambiguous = true; i++; continue; }
      let inClass = false;
      let closed = false;
      i++;
      while (i < text.length && text[i] !== '\n' && text[i] !== '\r') {
        const current = text[i++];
        if (current === '\\') {
          if (i < text.length && text[i] !== '\n' && text[i] !== '\r') i++;
        } else if (current === '[') inClass = true;
        else if (current === ']') inClass = false;
        else if (current === '/' && !inClass) { closed = true; break; }
      }
      ambiguous ||= !closed;
      expressionStart = false;
      continue;
    }
    chunks.push(text.slice(start, i), ' ');
    const block = text[i + 1] === '*';
    i += 2;
    while (i < text.length) {
      if (!block && (text[i] === '\n' || text[i] === '\r')) break;
      if (block && text[i] === '*' && text[i + 1] === '/') { i += 2; break; }
      if (text[i] === '\n' || text[i] === '\r') { chunks.push(text[i]); expressionStart = true; }
      i++;
    }
    start = i;
  }
  chunks.push(text.slice(start));
  return { text: chunks.join(''), ambiguous };
}

/** String-only compatibility wrapper. */
export function stripComments(text) {
  return stripCommentsWithStatus(text).text;
}

const PATH_CALLS = new Set(['execFileSync', 'spawn', 'spawnSync', 'exec', 'readFileSync', 'readFile']);
const IDENT_CHAR = /[\w$]/;

/** Literal arguments anywhere inside a spawn/read call, including nested argument arrays. */
function callPaths(text, add) {
  let depth = 0;
  const calls = [];
  let pending = false;
  for (let i = 0; i < text.length;) {
    const ch = text[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const end = stringEnd(text, i);
      const literal = text.slice(i + 1, end - 1);
      if (calls.length && text[end - 1] === ch && !literal.includes('\\') && !(ch === '`' && literal.includes('${'))) add(literal);
      i = end;
      pending = false;
    } else if (IDENT_CHAR.test(ch)) {
      const start = i++;
      while (i < text.length && IDENT_CHAR.test(text[i])) i++;
      pending = PATH_CALLS.has(text.slice(start, i));
    } else if (ch === '(') {
      depth++;
      if (pending) calls.push(depth);
      pending = false;
      i++;
    } else if (ch === ')') {
      if (calls.at(-1) === depth) calls.pop();
      depth--;
      pending = false;
      i++;
    } else {
      if (!/\s/.test(ch)) pending = false;
      i++;
    }
  }
}

/** Bounded, approximate forward edges. Oversized evidence is explicitly incomplete. */
export function staticEdgesOf(fromFile, text, fileSet, { aliases = {} } = {}) {
  text = String(text ?? '');
  if (text.length > MAX_INPUT_BYTES || Buffer.byteLength(text, 'utf8') > MAX_INPUT_BYTES) return { edges: [], partial: true };
  const { text: source, ambiguous } = stripCommentsWithStatus(text);
  const edges = new Set();
  const add = (target) => { if (target && target !== fromFile) edges.add(target); };
  const aliasEntries = Object.entries(aliases).filter(([prefix]) => prefix).sort((a, b) => b[0].length - a[0].length);
  for (const m of source.matchAll(SPECIFIER_RE)) {
    const spec = m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5];
    add(resolveSpecifier(fromFile, spec, fileSet));
    for (const [prefix, dir] of aliasEntries) {
      if (!spec.startsWith(prefix)) continue;
      const target = dir.replace(/\/$/, '') + '/' + spec.slice(prefix.length).replace(/^\//, '');
      add(resolveSpecifier('__shadow_root__.mjs', './' + target, fileSet));
      break;
    }
  }
  callPaths(source, (literal) => {
    if (fileSet.has(literal)) add(literal);
    else add(resolveSpecifier(fromFile, literal, fileSet));
  });
  return { edges: [...edges], partial: ambiguous };
}

/** Reverse reachability for diagnostics only; unreadable or bounded evidence stays partial. */
export function shadowSelection({ changedFiles, files, readFile, maxTests, aliases = {} }) {
  const tracked = files.filter((f) => !f.startsWith('node_modules/') && !f.includes('/node_modules/'));
  const fileSet = new Set(tracked);
  const reverse = new Map();
  let partial = false;
  for (const file of tracked.filter(isGraphSourceFile)) {
    let result;
    try { result = staticEdgesOf(file, readFile(file), fileSet, { aliases }); }
    catch { partial = true; continue; }
    partial ||= result.partial;
    for (const target of result.edges) {
      if (!reverse.has(target)) reverse.set(target, new Set());
      reverse.get(target).add(file);
    }
  }
  const tests = [...new Set([...changedFiles.filter(isVitestTestFile), ...testDepths(changedFiles, reverse).keys()])].sort();
  if (maxTests > 0 && tests.length > maxTests) return { tests: tests.slice(0, maxTests), partial: true };
  return { tests, partial };
}
