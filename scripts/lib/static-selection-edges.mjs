/** Shadow-only static dependencies; never used to choose a gate's tests. */
import { lstatSync, readFileSync } from 'node:fs';
import { resolve, relative, isAbsolute, sep } from 'node:path';
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

const EXPRESSION_KEYWORDS = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'void', 'yield', 'await']);

/** Linear lexical pass; preserve literals and expose uncertain slash contexts. */
export function stripCommentsWithStatus(text) {
  text = String(text ?? '');
  const chunks = [];
  let i = 0;
  let start = 0;
  let expressionStart = true;
  let ambiguous = false;
  let division = false;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\n' || ch === '\r') { i++; continue; }
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === "'" || ch === '"' || ch === '`') {
      i = stringEnd(text, i);
      expressionStart = false;
      division = true;
      continue;
    }
    if (/[\w$]/.test(ch)) {
      const tokenStart = i++;
      while (i < text.length && /[\w$]/.test(text[i])) i++;
      expressionStart = EXPRESSION_KEYWORDS.has(text.slice(tokenStart, i));
      division = !expressionStart;
      continue;
    }
    if (ch !== '/') {
      expressionStart = '(,=:[!&|?{;'.includes(ch);
      division = ch === ']';
      i++;
      continue;
    }
    if (text[i + 1] !== '/' && text[i + 1] !== '*') {
      if (!expressionStart) { ambiguous ||= !division; expressionStart = true; division = false; i++; continue; }
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
      expressionStart = !closed;
      division = false;
      continue;
    }
    chunks.push(text.slice(start, i), ' ');
    const block = text[i + 1] === '*';
    i += 2;
    while (i < text.length) {
      if (!block && (text[i] === '\n' || text[i] === '\r')) break;
      if (block && text[i] === '*' && text[i + 1] === '/') { i += 2; break; }
      if (text[i] === '\n' || text[i] === '\r') { chunks.push(text[i]); }
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

const PATH_CALLS = new Set(['execFile', 'fork', 'execFileSync', 'spawn', 'spawnSync', 'exec', 'readFileSync', 'readFile']);
const IDENT_CHAR = /[\w$]/;

/** Visit literals throughout the file and mark computed load arguments unknown. */
function callPaths(text, add) {
  let depth = 0;
  const calls = [];
  let load = false;
  let unknown = false;
  let pending = false;
  for (let i = 0; i < text.length;) {
    const ch = text[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const end = stringEnd(text, i);
      const literal = text.slice(i + 1, end - 1);
      if (text[end - 1] === ch && !literal.includes('\\') && !(ch === '`' && literal.includes('${'))) add(literal);
      i = end;
      pending = false;
    } else if (IDENT_CHAR.test(ch)) {
      const start = i++;
      while (i < text.length && IDENT_CHAR.test(text[i])) i++;
      const name = text.slice(start, i);
      pending = PATH_CALLS.has(name);
      load = ['import', 'require', 'mock', 'doMock', 'unmock', 'doUnmock', 'importActual', 'importMock'].includes(name);
    } else if (ch === '(') {
      if (load) {
        let arg = i + 1;
        while (arg < text.length && /\s/.test(text[arg])) arg++;
        const quote = text[arg];
        if (quote !== "'" && quote !== '"' && quote !== '`') unknown = true;
        else {
          const end = stringEnd(text, arg);
          const literal = text.slice(arg + 1, end - 1);
          let next = end;
          while (next < text.length && /\s/.test(text[next])) next++;
          unknown ||= text[end - 1] !== quote || literal.includes('\\') || (quote === '`' && literal.includes('${')) || ![')', ','].includes(text[next]);
        }
      }
      load = false;
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
      if (!/\s/.test(ch)) { pending = false; load = false; }
      i++;
    }
  }
  return unknown;
}

/** Bounded, approximate forward edges. Oversized evidence is explicitly incomplete. */
export function staticEdgesOf(fromFile, text, fileSet, { aliases = {} } = {}) {
  text = String(text ?? '');
  if (text.length > MAX_INPUT_BYTES || Buffer.byteLength(text, 'utf8') > MAX_INPUT_BYTES) return { edges: [], unknown: true, partial: true };
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
  const computed = callPaths(source, (literal) => {
    if (fileSet.has(literal)) add(literal);
    else add(resolveSpecifier(fromFile, literal, fileSet) || resolveSpecifier(fromFile, './' + literal, fileSet));
  });
  return { edges: [...edges], unknown: ambiguous || computed, partial: false };
}

/** Refuse symlinks, escapes and oversized inputs before reading any source bytes. */
export function readShadowFile(root, file) {
  const rel = relative(resolve(root), resolve(root, file));
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep)) throw Error('outside ROOT');
  let current = resolve(root);
  for (const part of rel.split(sep)) {
    current = resolve(current, part);
    if (lstatSync(current).isSymbolicLink()) throw Error('symlink');
  }
  const stat = lstatSync(current);
  if (!stat.isFile() || stat.size > MAX_INPUT_BYTES) throw Error('unreadable or over cap');
  return readFileSync(current, 'utf8');
}

/** Reverse reachability for diagnostics only. Unknown evidence can only widen selection. */
export function shadowSelection({ changedFiles, files, readFile, maxTests, aliases = {}, isFullSuiteTrigger = () => false }) {
  const tracked = files.filter((f) => !f.startsWith('node_modules/') && !f.includes('/node_modules/'));
  // Missing changed modules remain resolvable targets for their surviving importers.
  const fileSet = new Set([...tracked, ...changedFiles]);
  const changed = new Set(changedFiles);
  const reverse = new Map();
  const unknownFiles = [];
  const unreadable = new Set();
  const reasons = [];
  let partial = false;
  for (const file of fileSet) {
    if (!isGraphSourceFile(file)) continue;
    let result;
    try {
      const text = readFile(file);
      if (text == null) throw Error('missing file');
      result = staticEdgesOf(file, text, fileSet, { aliases });
    }
    catch { result = { edges: [], unknown: true, partial: true }; unreadable.add(file); }
    partial ||= result.partial && changed.has(file);
    if (result.unknown) unknownFiles.push(file);
    for (const target of result.edges) {
      if (!reverse.has(target)) reverse.set(target, new Set());
      reverse.get(target).add(file);
    }
  }
  const allTests = [...new Set([...tracked, ...changedFiles].filter(isVitestTestFile))].sort();
  const selected = new Set([
    ...changedFiles.filter(isVitestTestFile),
    ...testDepths([...changedFiles, ...unknownFiles], reverse).keys(),
    ...unknownFiles.filter(isVitestTestFile),
  ]);
  for (const file of changedFiles) {
    const trigger = isFullSuiteTrigger(file);
    if (trigger) reasons.push(`full-suite trigger: ${file}`);
    const missing = !tracked.includes(file) || unreadable.has(file);
    if (!trigger && missing && !isVitestTestFile(file) && testDepths([file], reverse).size === 0) reasons.push(`untracked/deleted or unreadable file reaches no test: ${file}`);
  }
  if (maxTests > 0 && selected.size > maxTests) reasons.push('test cap exceeded: full suite');
  // Capture escalation before adding diagnostic unknown reasons: unknowns widen reach, not mode.
  const result = { mode: reasons.length ? 'full' : 'related', tests: reasons.length ? allTests : [...selected].sort(), staticTests: [...selected].sort(), partial, unknownFiles: unknownFiles.sort(), reasons, totalTests: allTests.length };
  reasons.push(...result.unknownFiles.map((file) => `unknown file: ${file}`));
  return result;
}
