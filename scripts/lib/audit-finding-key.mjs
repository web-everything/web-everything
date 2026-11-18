/** @file Pure, prose-independent audit identities and approximate head-source symbol lookup. */
import { posix } from 'node:path';
import { FINDING_CLASSES } from '../operations/audit-verdict.mjs';

/** Repo-relative paths only; reject escaping/absolute evidence instead of guessing a root. */
export function findingKey({ file, symbol = '<top>', class: cls }) {
  if (typeof file !== 'string' || !file || /[\\|\s:]/.test(file) || file.startsWith('/')) throw new Error('invalid finding path');
  const path = posix.normalize(file);
  if (path === '.' || path === '..' || path.startsWith('../') || !FINDING_CLASSES.includes(cls)
    || typeof symbol !== 'string' || /[|\r\n]/.test(symbol)) throw new Error('invalid finding identity');
  return `${path}|${symbol || '<top>'}|${cls}`;
}

/** Extract a single unambiguous path:line; prose otherwise never participates in identity. */
export function parseFindingLocation(findingText) {
  if (typeof findingText !== 'string') return null;
  const matches = [...findingText.matchAll(/(?:^|[\s`(["'])((?:\.\/)?[\w./@+-]+):(\d+)(?=$|[\s`),;:.\]"'])/g)];
  if (matches.length !== 1) return null;
  const [, file, number] = matches[0], line = Number(number);
  try {
    const path = findingKey({ file, class: 'B1' }).split('|')[0];
    return Number.isSafeInteger(line) && line > 0 ? { file: path, line } : null;
  } catch { return null; }
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
