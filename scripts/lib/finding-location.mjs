/** Pure finding locations shared by runtime routing and the audit identity tools. */
import { posix } from 'node:path';

/** Repo-relative paths only; reject escaping/absolute evidence instead of guessing a root. */
export function normalizeFindingPath(file) {
  if (typeof file !== 'string' || !file || /[\\|\s:]/.test(file) || file.startsWith('/')) throw new Error('invalid finding path');
  const path = posix.normalize(file);
  if (path === '.' || path === '..' || path.startsWith('../')) throw new Error('invalid finding identity');
  return path;
}

/** Extract a single unambiguous path:line; prose otherwise never participates in identity. */
export function parseFindingLocation(findingText) {
  if (typeof findingText !== 'string') return null;
  const matches = [...findingText.matchAll(/(?:^|[\s`(["'])((?:\.\/)?[\w./@+-]+):(\d+)(?=$|[\s`),;:.\]"'])/g)];
  if (matches.length !== 1) return null;
  const [, file, number] = matches[0], line = Number(number);
  try {
    const path = normalizeFindingPath(file);
    return Number.isSafeInteger(line) && line > 0 ? { file: path, line } : null;
  } catch { return null; }
}
