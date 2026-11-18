/** Narrow, fail-closed resolution of append-only advisory registries; never resolves source conflicts. */
import { lstatSync, mkdtempSync, readFileSync, readlinkSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { FULL_SHA_RE } from './shared.mjs';

export const ADVISORY_MERGE_PATHS = Object.freeze(['scripts/ci/test-timings.json', 'scripts/conveyor/soak/breaks/index.mjs']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Union object entries, conservatively retaining the larger numeric observation. */
export function mergeTimingsJson(baseText, oursText, theirsText) {
  try {
    const [base, ours, theirs] = [baseText, oursText, theirsText].map(text => JSON.parse(text));
    if (![base, ours, theirs].every(value => object(value) && object(value.unit) && object(value.soak))) return null;
    const merge = (b, o, t) => {
      if (typeof o === 'number' && typeof t === 'number') return Math.max(o, t);
      if (object(o) && object(t)) {
        return Object.fromEntries([...new Set([...Object.keys(o), ...Object.keys(t)])].sort().map(key => [
          key, merge(object(b) ? b[key] : undefined, o[key], t[key]),
        ]));
      }
      if (o === undefined) return t;
      if (t === undefined || isDeepStrictEqual(o, t)) return o;
      if (isDeepStrictEqual(o, b)) return t;
      if (isDeepStrictEqual(t, b)) return o;
      throw new Error('incompatible advisory values');
    };
    const merged = merge(base, ours, theirs);
    const { _doc, unit, soak, ...rest } = merged;
    return `${JSON.stringify({ _doc, unit, soak, ...rest }, null, 1)}\n`;
  } catch { return null; }
}

// Preserve every base line; match identical cross-side additions one-for-one at each base gap.
// A non-additive edit is outside this registry contract; leave it for operator resolution.
function mergeRegistryLines(baseText, oursText, theirsText) {
  const lines = text => text.match(/[^\n]*\n|[^\n]+$/g) || [];
  const base = lines(baseText), gaps = base.map(() => []);
  const headerEnd = base.findIndex(line => line === ' */\n' || line === ' */');
  if (base[0] !== '/**\n' || headerEnd < 1) return null;
  gaps.push([]);
  const added = gaps.map(() => new Map());
  for (const [side, text] of [oursText, theirsText].entries()) {
    let cursor = 0;
    for (const line of lines(text)) {
      if (cursor < base.length && line === base[cursor]) cursor++;
      else {
        if (cursor === 0 || cursor > headerEnd || !/^ \* /.test(line) || line.includes('/*') || line.includes('*/')) return null;
        const count = added[cursor].get(line) || 0;
        if (side === 1 && count > 0) added[cursor].set(line, count - 1);
        else {
          gaps[cursor].push(line);
          if (side === 0) added[cursor].set(line, count + 1);
        }
      }
    }
    if (cursor !== base.length) return null;
  }
  const merged = gaps.map((gap, i) => gap.join('') + (base[i] || '')).join('');
  return /^(?:<{7}|={7}|>{7}|\|{7})/m.test(merged) ? null : merged;
}

function validateModule(path) {
  const sentinel = `advisory-import-complete:${randomUUID()}`;
  const result = spawnSync(process.execPath,
    ['--input-type=module', '-e', `await import(process.argv[1]); console.log(${JSON.stringify(sentinel)})`, pathToFileURL(path).href], {
    encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
  });
  return result.status === 0 && result.stdout?.split('\n').includes(sentinel);
}

function readMerge(git, revisions, path) {
  const inputs = revisions.map(revision => git(['show', `${revision}:${path}`]));
  if (inputs.some(result => result.status !== 0)) return null;
  return (path === ADVISORY_MERGE_PATHS[0] ? mergeTimingsJson : mergeRegistryLines)(
    ...inputs.map(result => String(result.stdout)));
}

const advisoryOnly = paths => paths.length > 0 && paths.every(path => ADVISORY_MERGE_PATHS.includes(path));

/** Builds a tree using an isolated index, leaving the caller's index and checkout untouched. */
export function resolveAdvisoryConflicts({ git, cur, ovSha }) {
  let scratch;
  try {
    if (![cur, ovSha].every(revision => FULL_SHA_RE.test(revision))) return null;
    const result = git(['merge-tree', '--write-tree', '--name-only', cur, ovSha]);
    if (result.status !== 1) return null;
    const lines = String(result.stdout ?? '').split('\n');
    const tree = lines.shift();
    const end = lines.indexOf('');
    if (!FULL_SHA_RE.test(tree) || end < 0) return null;
    const paths = lines.slice(0, end);
    // Registry unions need real import validation in resolveAdvisoryInWorktree.
    if (paths.length === 0 || paths.some(path => path !== ADVISORY_MERGE_PATHS[0])) return null;
    const base = git(['merge-base', '--all', cur, ovSha]);
    const baseSha = String(base.stdout ?? '').trim();
    if (base.status !== 0 || !FULL_SHA_RE.test(baseSha)) return null;
    // A private index permits adopting the clean merge-tree entries without touching the real index.
    scratch = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'we-advisory-merge-'));
    const options = { env: { GIT_INDEX_FILE: join(scratch, 'index') } };
    if (git(['read-tree', tree], options).status !== 0) return null;
    for (const path of paths) {
      const text = readMerge(git, [baseSha, cur, ovSha], path);
      if (text === null) return null;
      const blobPath = join(scratch, 'timings.json');
      writeFileSync(blobPath, text);
      const blob = git(['hash-object', '-w', '--', blobPath]);
      const blobSha = String(blob.stdout ?? '').trim();
      if (blob.status !== 0 || !FULL_SHA_RE.test(blobSha)) return null;
      if (git(['update-index', '--add', '--cacheinfo', '100644', blobSha, path], options).status !== 0) return null;
    }
    const written = git(['write-tree'], options);
    const mergedTree = String(written.stdout ?? '').trim();
    return written.status === 0 && FULL_SHA_RE.test(mergedTree)
      ? { ok: true, via: 'advisory-merge', tree: mergedTree } : null;
  } catch { return null; }
  finally { if (scratch) rmSync(scratch, { recursive: true, force: true }); }
}

/** Resolves only an advisory-only in-progress merge, then completes its merge commit. */
export function resolveAdvisoryInWorktree({ git, cwd }) {
  try {
    const unmerged = git(['diff', '--name-only', '-z', '--diff-filter=U']);
    if (unmerged.status !== 0) return false;
    const paths = String(unmerged.stdout ?? '').split('\0').filter(Boolean);
    if (!advisoryOnly(paths)) return false;
    const mergeHead = git(['rev-parse', '--verify', 'MERGE_HEAD']);
    if (mergeHead.status !== 0 || !FULL_SHA_RE.test(String(mergeHead.stdout ?? '').trim())) return false;
    const merged = paths.map(path => ({ path, text: readMerge(git, [':1', ':2', ':3'], path) }));
    if (merged.some(({ text }) => text === null)) return false;
    const checkedGit = args => {
      const result = git(args);
      if (result.status !== 0 || result.stdout == null) throw new Error('unreadable validation snapshot');
      return String(result.stdout);
    };
    const status = () => [checkedGit(['status', '--porcelain=v1', '-z']), checkedGit(['ls-files', '-u', '-z'])];
    const files = () => [...new Set(checkedGit(['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean))];
    // Import validation executes code: retain checkout bytes and the index for rollback.
    // Unknown file types refuse before any writes; the caller can leave resolution to an operator.
    const snapshotFile = path => {
      const fullPath = join(cwd, path);
      const stat = lstatSync(fullPath, { throwIfNoEntry: false });
      if (stat && !stat.isFile() && !stat.isSymbolicLink()) throw new Error('unsupported validation snapshot file');
      return stat ? { link: stat.isSymbolicLink(),
        data: stat.isSymbolicLink() ? readlinkSync(fullPath) : readFileSync(fullPath) } : null;
    };
    const originals = new Map(files().map(path => [path, snapshotFile(path)]));
    const validated = new Map(originals);
    for (const { path, text } of merged) validated.set(path, { link: false, data: Buffer.from(text) });
    const indexPath = resolve(cwd, checkedGit(['rev-parse', '--git-path', 'index']).trim());
    const originalIndex = readFileSync(indexPath);
    const restore = () => {
      for (const path of files()) {
        if (!originals.has(path)) rmSync(join(cwd, path), { force: true });
      }
      for (const [path, original] of originals) {
        const fullPath = join(cwd, path);
        if (original === null) rmSync(fullPath, { force: true });
        else {
          const current = lstatSync(fullPath, { throwIfNoEntry: false });
          if (original.link || (current && !current.isFile())) rmSync(fullPath, { recursive: true, force: true });
          if (original.link) symlinkSync(original.data, fullPath);
          else writeFileSync(fullPath, original.data);
        }
      }
      writeFileSync(indexPath, originalIndex);
      return false;
    };
    try {
      for (const { path, text } of merged) writeFileSync(join(cwd, path), text);
      const beforeValidation = status();
      for (const { path } of merged) {
        if (path.endsWith('.mjs') && !validateModule(join(cwd, path))) return restore();
      }
      if (!isDeepStrictEqual(beforeValidation, status()) || [...validated].some(([path, expected]) =>
        !isDeepStrictEqual(snapshotFile(path), expected))) return restore();
      if (git(['add', '--', ...paths]).status !== 0) return restore();
      const remaining = git(['diff', '--name-only', '-z', '--diff-filter=U']);
      if (remaining.status !== 0 || String(remaining.stdout ?? '') !== '') return restore();
      return git(['commit', '--no-edit']).status === 0 || restore();
    } catch { return restore(); }
  } catch { return false; }
}
