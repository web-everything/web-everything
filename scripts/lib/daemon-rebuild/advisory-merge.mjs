/** Narrow, fail-closed resolution of append-only advisory registries; never resolves source conflicts. */
import { copyFileSync, mkdirSync, realpathSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { spawnSync } from 'node:child_process';
import { FULL_SHA_RE } from './shared.mjs';

export const ADVISORY_MERGE_PATHS = Object.freeze(['scripts/ci/test-timings.json', 'scripts/conveyor/soak/breaks/index.mjs']);
export const GENERATED_MERGE_PATHS = Object.freeze({
  'docs/agent/settings-registry.md': Object.freeze({
    closure: Object.freeze(['scripts/lib/settings-registry.mjs', 'scripts/lib/settings-files.mjs', 'scripts/lib/operator-override-reader.mjs']),
    inputs: Object.freeze(['scripts/settings/', 'scripts/dispatch-settings.json', 'scripts/lib/settings-registry-metadata.json',
      'scripts/lib/delivery-platform-preferences.json', 'scripts/lib/delivery-priority-settings.json']),
    argv: Object.freeze(['--write']),
  }),
});
const childEnv = () => Object.fromEntries(['PATH', 'HOME', 'TMPDIR'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));

/** Run only the pinned tree's complete generator closure; incomplete evidence retains the conflict. */
export function regenerateFromTree({ git, tree, path }) {
  let scratch;
  try {
    if (!Object.hasOwn(GENERATED_MERGE_PATHS, path) || !FULL_SHA_RE.test(tree)) return null;
    const { closure, inputs, argv } = GENERATED_MERGE_PATHS[path], required = [...closure, ...inputs];
    const listed = git(['ls-tree', '-r', '-z', '--full-tree', tree, '--', ...required]);
    if (listed.status !== 0) return null;
    const entries = String(listed.stdout).split('\0').filter(Boolean).map(entry => {
      const match = /^(100644|100755) blob ([0-9a-f]{40})\t(.+)$/.exec(entry);
      if (!match || match[3].split('/').some(part => !part || part === '.' || part === '..')) throw Error('unsafe generator entry');
      return { sha: match[2], name: match[3] };
    });
    if (required.some(item => !entries.some(({ name }) => item.endsWith('/') ? name.startsWith(item) : name === item))) return null;
    // realpath: the generator's main-module guard compares import.meta.url (real path) with argv[1]; a symlinked
    // TMPDIR (macOS /var -> /private/var) would make it silently do nothing and exit 0.
    scratch = realpathSync(mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'we-generated-merge-')));
    for (const { sha, name } of entries) {
      const blob = git(['cat-file', 'blob', sha]);
      if (blob.status !== 0) return null;
      mkdirSync(dirname(join(scratch, name)), { recursive: true });
      writeFileSync(join(scratch, name), blob.stdout);
    }
    mkdirSync(dirname(join(scratch, path)), { recursive: true });
    for (const args of [argv, ['--check']]) {
      const result = spawnSync(process.execPath, [join(scratch, closure[0]), ...args], {
        cwd: scratch, env: childEnv(), encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
      });
      if (result.status !== 0 || result.error) return null;
    }
    return readFileSync(join(scratch, path), 'utf8');
  } catch { return null; }
  finally { if (scratch) { try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best-effort cleanup */ } } }
}

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
  const headerEnd = base.findIndex(line => line.includes('*/'));
  if (base[0] !== '/**\n' || headerEnd < 1 || ![' */\n', ' */'].includes(base[headerEnd])) return null;
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

// The card's "must import" requirement is satisfied by construction plus node --check:
// only delimiter-free header comment lines can be added, so executable bytes stay unchanged.
// Syntax validation must never execute the registry or resolve its imports.
function checkModuleSyntax(path) {
  return spawnSync(process.execPath, ['--check', path], {
    encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
  }).status === 0;
}

function readMerge(git, revisions, path, tree) {
  const inputs = revisions.map(revision => git(['show', `${revision}:${path}`]));
  if (inputs.some(result => result.status !== 0)) return null;
  if (Object.hasOwn(GENERATED_MERGE_PATHS, path)) return regenerateFromTree({ git, tree, path });
  return (path === ADVISORY_MERGE_PATHS[0] ? mergeTimingsJson : mergeRegistryLines)(
    ...inputs.map(result => String(result.stdout)));
}

const advisoryOnly = paths => paths.length > 0 && paths.every(path => ADVISORY_MERGE_PATHS.includes(path) || Object.hasOwn(GENERATED_MERGE_PATHS, path));

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
    // A private index permits adopting the clean merge-tree entries without touching the real index.
    scratch = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'we-advisory-merge-'));
    const options = { env: { GIT_INDEX_FILE: join(scratch, 'index') } };
    if (git(['read-tree', tree], options).status !== 0) return null;
    for (const path of paths) {
      const text = readMerge(git, [baseSha, cur, ovSha], path, tree);
      if (text === null) return null;
      const blobPath = join(scratch, path.endsWith('.mjs') ? 'index.mjs' : 'timings.json');
      writeFileSync(blobPath, text);
      if (path.endsWith('.mjs') && !checkModuleSyntax(blobPath)) return null;
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
  finally { if (scratch) { try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best-effort cleanup */ } } }
}

/** Resolves only an advisory-only in-progress merge, then completes its merge commit. */
export function resolveAdvisoryInWorktree({ git, cwd, commit = true }) {
  let scratch;
  try {
    const unmerged = git(['diff', '--name-only', '-z', '--diff-filter=U']);
    if (unmerged.status !== 0) return false;
    const paths = String(unmerged.stdout ?? '').split('\0').filter(Boolean);
    if (!advisoryOnly(paths)) return false;
    const mergeHead = git(['rev-parse', '--verify', 'MERGE_HEAD']);
    const inProgress = mergeHead.status === 0 ? mergeHead : !commit ? git(['rev-parse', '--verify', 'REBASE_HEAD']) : mergeHead;
    if (inProgress.status !== 0 || !FULL_SHA_RE.test(String(inProgress.stdout ?? '').trim())) return false;
    let tree;
    if (paths.some(path => Object.hasOwn(GENERATED_MERGE_PATHS, path))) {
      const index = git(['rev-parse', '--git-path', 'index']);
      if (index.status !== 0 || !String(index.stdout ?? '').trim()) return false;
      scratch = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'we-generated-index-'));
      copyFileSync(resolve(cwd, String(index.stdout).trim()), join(scratch, 'index'));
      // Some legacy git callbacks accept argv only. Run the private-index writes directly so they cannot
      // silently drop GIT_INDEX_FILE and mutate the caller's index. Removing unmerged paths leaves stage 0.
      const privateGit = args => spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000,
        killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, env: { ...childEnv(), GIT_INDEX_FILE: join(scratch, 'index') } });
      if (privateGit(['update-index', '--force-remove', '--', ...paths]).status !== 0) return false;
      const written = privateGit(['write-tree']);
      tree = String(written.stdout ?? '').trim();
      if (written.status !== 0 || !FULL_SHA_RE.test(tree)) return false;
    }
    const merged = paths.map(path => ({ path, text: readMerge(git, [':1', ':2', ':3'], path, tree) }));
    if (merged.some(({ text }) => text === null)) return false;
    // Back up only the files we will stage and the index, for rollback on any failure.
    const originals = new Map(paths.map(path => {
      const fullPath = join(cwd, path);
      const stat = lstatSync(fullPath);
      if (Object.hasOwn(GENERATED_MERGE_PATHS, path) && stat.isSymbolicLink()) throw new Error('generated file is a symlink');
      if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error('unsupported advisory file');
      return [path, { link: stat.isSymbolicLink(),
        data: stat.isSymbolicLink() ? readlinkSync(fullPath) : readFileSync(fullPath) }];
    }));
    const index = git(['rev-parse', '--git-path', 'index']);
    if (index.status !== 0 || !String(index.stdout ?? '').trim()) return false;
    const indexPath = resolve(cwd, String(index.stdout).trim());
    const originalIndex = readFileSync(indexPath);
    const restore = () => {
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
      const generatedHashes = new Map();
      for (const { path } of merged) {
        if (path.endsWith('.mjs') && !checkModuleSyntax(join(cwd, path))) return restore();
        if (Object.hasOwn(GENERATED_MERGE_PATHS, path)) {
          const blob = git(['hash-object', '--no-filters', '--', join(cwd, path)]);
          const sha = String(blob.stdout ?? '').trim();
          if (blob.status !== 0 || !FULL_SHA_RE.test(sha)) return restore();
          generatedHashes.set(path, sha);
        }
      }
      if (git(['add', '--', ...paths]).status !== 0) return restore();
      for (const [path, sha] of generatedHashes) {
        const staged = git(['rev-parse', `:${path}`]);
        if (staged.status !== 0 || String(staged.stdout ?? '').trim() !== sha) return restore();
      }
      const remaining = git(['diff', '--name-only', '-z', '--diff-filter=U']);
      if (remaining.status !== 0 || String(remaining.stdout ?? '') !== '') return restore();
      return !commit || git(['commit', '--no-edit']).status === 0 || restore();
    } catch { return restore(); }
  } catch { return false; }
  finally { if (scratch) { try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best-effort cleanup */ } } }
}
