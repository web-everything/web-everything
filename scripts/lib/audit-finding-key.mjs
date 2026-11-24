/** @file Pure, prose-independent audit identities and approximate head-source symbol lookup. */
import { normalizeFindingPath } from './finding-location.mjs';
export { parseFindingLocation } from './finding-location.mjs';
import { FINDING_CLASSES } from '../operations/audit-verdict.mjs';

/** Repo-relative paths only; reject escaping/absolute evidence instead of guessing a root. */
export function findingKey({ file, symbol = '<top>', class: cls }) {
  const path = normalizeFindingPath(file);
  if (!FINDING_CLASSES.includes(cls)
    || typeof symbol !== 'string' || /[|\r\n]/.test(symbol)) throw new Error('invalid finding identity');
  return `${path}|${symbol || '<top>'}|${cls}`;
}

/** Simple regex/brace scan, not a JS parser. Strings/comments are masked, preserving offsets. */
export function symbolAt(sourceText, line) {
  if (typeof sourceText !== 'string' || !Number.isSafeInteger(line) || line < 1) return '<top>';
  const source = sourceText.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|'(?:\\[\s\S]|[^'\\])*'|"(?:\\[\s\S]|[^"\\])*"|`(?:\\[\s\S]|[^`\\])*`/g,
    s => s.replace(/[^\n]/g, ' '));
  const lines = source.split('\n');
  if (line > lines.length) return '<top>';
  const start = lines.slice(0, line - 1).reduce((n, s) => n + s.length + 1, 0), end = start + lines[line - 1].length;
  const names = new Map(), expressions = [];
  const declarations = /\bfunction\s*\*?\s+([\w$]+)\s*\([^)]*\)\s*\{|\bconst\s+([\w$]+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[\w$]+)\s*=>\s*|\b([\w$]+)\s*\([^)]*\)\s*\{/g;
  for (const m of source.matchAll(declarations)) {
    const name = m[1] || m[2] || m[3];
    if (['if', 'for', 'while', 'switch', 'catch', 'with'].includes(name)) continue;
    const opening = m.index + m[0].length - (m[2] ? 0 : 1);
    if (source[opening] === '{') names.set(opening, { name, start: m.index });
    else expressions.push({ name, start: m.index, end: source.indexOf(';', opening) < 0 ? source.length : source.indexOf(';', opening) });
  }
  const stack = [], scopes = [...expressions];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '{') stack.push(names.get(i) || null);
    if (source[i] === '}') { const scope = stack.pop(); if (scope) scopes.push({ ...scope, end: i }); }
  }
  return scopes.filter(s => s.start <= end && s.end >= start).sort((a, b) => b.start - a.start)[0]?.name || '<top>';
}
