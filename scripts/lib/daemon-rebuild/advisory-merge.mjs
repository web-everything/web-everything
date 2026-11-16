/** Narrow, fail-closed resolution of advisory timing data; never resolves source conflicts. */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { FULL_SHA_RE } from './shared.mjs';

export const ADVISORY_MERGE_PATHS = Object.freeze(['scripts/ci/test-timings.json']);
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

function readMerge(git, revisions, path) {
  const inputs = revisions.map(revision => git(['show', `${revision}:${path}`]));
  if (inputs.some(result => result.status !== 0)) return null;
  return mergeTimingsJson(...inputs.map(result => String(result.stdout)));
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
    if (!advisoryOnly(paths)) return null;
    const base = git(['merge-base', '--all', cur, ovSha]);
    const baseSha = String(base.stdout ?? '').trim();
    if (base.status !== 0 || !FULL_SHA_RE.test(baseSha)) return null;
    const text = readMerge(git, [baseSha, cur, ovSha], paths[0]);
    if (text === null) return null;
    // A private index permits adopting the clean merge-tree entries without touching the real index.
    scratch = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'we-advisory-merge-'));
    const blobPath = join(scratch, 'timings.json');
    writeFileSync(blobPath, text);
    const blob = git(['hash-object', '-w', '--', blobPath]);
    const blobSha = String(blob.stdout ?? '').trim();
    if (blob.status !== 0 || !FULL_SHA_RE.test(blobSha)) return null;
    const options = { env: { GIT_INDEX_FILE: join(scratch, 'index') } };
    if (git(['read-tree', tree], options).status !== 0) return null;
    if (git(['update-index', '--add', '--cacheinfo', '100644', blobSha, paths[0]], options).status !== 0) return null;
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
    const text = readMerge(git, [':1', ':2', ':3'], paths[0]);
    if (text === null) return false;
    const restore = () => { try { git(['checkout', '-m', '--', ...paths]); } catch { /* caller aborts the merge */ } return false; };
    try {
      writeFileSync(join(cwd, paths[0]), text);
      if (git(['add', '--', ...paths]).status !== 0) return restore();
      const remaining = git(['diff', '--name-only', '-z', '--diff-filter=U']);
      if (remaining.status !== 0 || String(remaining.stdout ?? '') !== '') return restore();
      return git(['commit', '--no-edit']).status === 0 || restore();
    } catch { return restore(); }
  } catch { return false; }
}
