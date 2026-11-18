/** Narrow, fail-closed resolution of append-only advisory registries; never resolves source conflicts. */
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { spawnSync } from 'node:child_process';
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
  gaps.push([]);
  const added = gaps.map(() => new Map());
  for (const [side, text] of [oursText, theirsText].entries()) {
    let cursor = 0;
    for (const line of lines(text)) {
      if (cursor < base.length && line === base[cursor]) cursor++;
      else {
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
  return spawnSync(process.execPath,
    ['--input-type=module', '-e', 'await import(process.argv[1])', pathToFileURL(path).href], {
    encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
  }).status === 0;
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
    const merged = paths.map(path => ({ path, text: readMerge(git, [':1', ':2', ':3'], path),
      original: readFileSync(join(cwd, path)) }));
    if (merged.some(({ text }) => text === null)) return false;
    let stagingAttempted = false;
    const restore = () => {
      if (stagingAttempted) {
        try { git(['checkout', '-m', '--', ...paths]); } catch { /* caller aborts the merge */ }
      }
      for (const { path, original } of merged) writeFileSync(join(cwd, path), original);
      return false;
    };
    try {
      for (const { path, text } of merged) writeFileSync(join(cwd, path), text);
      for (const { path } of merged) {
        if (path.endsWith('.mjs') && !validateModule(join(cwd, path))) return restore();
      }
      stagingAttempted = true;
      if (git(['add', '--', ...paths]).status !== 0) return restore();
      const remaining = git(['diff', '--name-only', '-z', '--diff-filter=U']);
      if (remaining.status !== 0 || String(remaining.stdout ?? '') !== '') return restore();
      return git(['commit', '--no-edit']).status === 0 || restore();
    } catch { return restore(); }
  } catch { return false; }
}
