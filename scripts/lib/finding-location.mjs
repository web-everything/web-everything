/** Pure finding locations shared by runtime routing and the audit identity tools. */
import { posix } from 'node:path';

/** Repo-relative paths only; reject escaping/absolute evidence instead of guessing a root. */
export function normalizeFindingPath(file) {
  if (typeof file !== 'string' || !file || /[\\|\s:]/.test(file) || file.startsWith('/')) throw new Error('invalid finding path');
  const path = posix.normalize(file);
  if (path === '.' || path === '..' || path.startsWith('../')) throw new Error('invalid finding identity');
  return path;
}

/** Extract a single unambiguous path:line; optionally include the surrounding description for lineage keys. */
export function parseFindingLocation(findingText, { includeDescription = false } = {}) {
  if (typeof findingText !== 'string') return null;
  const matches = [...findingText.matchAll(/(?:^|[\s`(["'])((?:\.\/)?[\w./@+-]+):(\d+)(?=$|[\s`),;:.\]"'])/g)];
  if (matches.length !== 1) return null;
  const [, file, number] = matches[0], line = Number(number);
  try {
    const path = normalizeFindingPath(file);
    return Number.isSafeInteger(line) && line > 0 ? { file: path, line,
      ...(includeDescription ? { description: `${findingText.slice(0, matches[0].index)} ${findingText.slice(matches[0].index + matches[0][0].length)}` } : {}) } : null;
  } catch { return null; }
}
