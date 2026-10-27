/** Pure size accounting shared by declarations and producer admission. */
import { BUILT_IN_PR_SIZE_SETTINGS } from './pr-size-defaults.mjs';

export const OPEN_PR_MAX_NON_TEST_LINES = 300;

/** Pure git --numstat -z accounting (also accepts legacy unquoted newline rows).
 * Binary rows are unmeasurable; malformed or incomplete evidence must never become a zero-sized diff.
 */
export function parseNumstat(numstatText) {
  if (typeof numstatText !== 'string') throw new Error('numstat must be text');
  if (!numstatText) return [];
  const nulDelimited = numstatText.includes('\0');
  if (nulDelimited && !numstatText.endsWith('\0')) throw new Error('unterminated numstat record');
  const rows = nulDelimited ? numstatText.slice(0, -1).split('\0') : numstatText.replace(/\n$/, '').split('\n');
  const entries = [];
  for (let i = 0; i < rows.length; i++) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(rows[i]);
    if (!match) throw new Error('unreadable numstat line');
    const [, additions, deletions] = match;
    let paths = [match[3]];
    // -z represents a rename as counts + empty path, then the old and new paths.
    if (nulDelimited && !paths[0]) {
      const source = rows[++i];
      const destination = rows[++i];
      if (!source || !destination) throw new Error('incomplete numstat rename');
      paths = [source, destination];
    }
    if (paths.some((path) => !path || (!nulDelimited && /[\t\r\n]|^"/.test(path)))) throw new Error('unreadable numstat path');
    if ((additions === '-') !== (deletions === '-')) throw new Error('unreadable numstat counts');
    if (additions === '-') throw new Error('unmeasurable numstat counts');
    const changed = Number(additions) + Number(deletions);
    if (!Number.isSafeInteger(changed)) throw new Error('numstat count exceeds safe integer range');
    entries.push({ paths, changed });
  }
  return entries;
}

export const isTestPath = (path) => /(^|\/)__tests__\//.test(path) || /(^|\/)[^/]*\.(test|spec)\.[^/]+$/.test(path);

// Both sides of a rename must be data. Unsafe paths, code and markdown always count.
function isDataPath(path, settings) {
  const segments = path.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) return false;
  const filename = segments.pop();
  const dot = filename.lastIndexOf('.');
  if (dot === -1 || !BUILT_IN_PR_SIZE_SETTINGS.dataExtensions.includes(filename.slice(dot))) return false;
  if (settings.dataPaths.includes(path)) return true;
  return settings.dataExtensions.includes(filename.slice(dot))
    && segments.some(segment => settings.dataDirs.includes(segment));
}

export function measureEntries(entries, settings = BUILT_IN_PR_SIZE_SETTINGS) {
  let lines = 0, dataLines = 0;
  for (const { paths, changed } of entries) {
    if (paths.every(path => isDataPath(path, settings))) dataLines += changed;
    else if (!paths.every(isTestPath)) lines += changed;
    if (!Number.isSafeInteger(lines) || !Number.isSafeInteger(dataLines)) {
      throw new Error('numstat total exceeds safe integer range');
    }
  }
  return { lines, dataLines,
    exempt: entries.length > 0 && entries.every(({ paths }) => paths.every(path => path.startsWith('backlog/'))) };
}

export function measureNonTestLines(text, settings = BUILT_IN_PR_SIZE_SETTINGS) {
  return measureEntries(parseNumstat(text), settings);
}
