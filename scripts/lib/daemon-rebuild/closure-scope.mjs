/** Pure closure-scoping policy; no merge/rebuild wiring. An ok:false result means retain
 * the conflict and use the existing full-merge/manual-rebase path, never a partial scope.
 * Reader contract: {root, readFile(absOrRelative), exists(absOrRelative), listFiles()}.
 * overlayChangedFiles is a Map<repoPath, source|null> (null deletes), laid over main.
 * Alternatively pass git + mainSha + overlays:[{sha,changedFiles:string[]}]; overlay
 * order is application order. Explicit overlayChangedFiles is laid on top last. */
import { basename, isAbsolute, relative, resolve } from 'node:path';
import { collectRunClosure, treeReader, smokeSurfaceEntries,
  MANIFEST_RE, CONFIG_RE, EXECUTABLE_RE, RUNTIME_READ_RE } from './skip-unrelated.mjs';
import { REBUILD_MECHANISM_PATHS } from './plan.mjs';
import { isCodePath } from '../main-staleness.mjs';
import { PARSEABLE_CODE_RE } from '../import-closure.mjs';

const LIMIT = 4000;
const metadata = new WeakMap();
const validPath = p => typeof p === 'string' && p.length > 0 && !isAbsolute(p)
  && !p.split('/').some(part => part === '..' || part === '.') && !p.includes('\0');
// Markdown and JSON can be read by exported ticks long after boot, with computed paths that
// an import closure cannot prove unused. Retain it even under tests/ or backlog/.
const always = p => MANIFEST_RE.test(p) || CONFIG_RE.test(p) || EXECUTABLE_RE.test(p)
  || RUNTIME_READ_RE.test(p) || /\.(md|json)$/i.test(p) || !PARSEABLE_CODE_RE.test(p);
const under = (p, prefix) => prefix.endsWith('/') ? p.startsWith(prefix) : p === prefix;

/** Unknown paths are retained. Membership and mandatory rules take precedence over
 * excludable categories, including tests/docs that are themselves in the closure. */
export function isExcludable(path, scope) {
  if (!validPath(path) || !(scope instanceof Set) || scope.has(path) || always(path)) return false;
  const { mechanismPaths = REBUILD_MECHANISM_PATHS, jsonNames = new Set() } = metadata.get(scope) || {};
  if (mechanismPaths.some(p => under(path, p)) || (path.endsWith('.json') && jsonNames.has(basename(path)))) return false;
  return isCodePath(path) || /(^|\/)(__tests__|tests)\//.test(path)
    || /\.(test|spec)\.[cm]?[jt]sx?$/.test(path) || path.startsWith('backlog/');
}

function layeredReader(base, layers) {
  base.assertRegularFiles?.();
  for (const { reader } of layers) reader.assertRegularFiles?.();
  const root = resolve(base.root);
  const sources = new Map(base.listFiles().map(path => [path, base]));
  for (const { reader, files } of layers) for (const path of files) {
    if (!validPath(path)) throw new Error('invalid overlay path');
    if (reader.exists(resolve(reader.root, path))) sources.set(path, reader);
    else sources.delete(path);
  }
  const key = path => relative(root, resolve(root, path));
  const names = new Map();
  for (const p of sources.keys()) if (/\.[cm]?[jt]s$/.test(p)) {
    const name = basename(p).normalize('NFC').toLowerCase();
    (names.get(name) || names.set(name, []).get(name)).push(p);
  }
  return { root, exists: path => sources.has(key(path)), listFiles: () => [...sources.keys()],
    byName: name => names.get(name.normalize('NFC').toLowerCase()) || [],
    readFile(path) {
      const p = key(path), source = sources.get(p);
      if (!source) throw new Error('scope file unreadable');
      return source.readFile(resolve(source.root, p));
    },
  };
}

export function computeClosureScope({ reader, git, mainSha, overlays = [], overlayChangedFiles = new Map(),
  entries, mechanismPaths = REBUILD_MECHANISM_PATHS, env = {},
}) {
  try {
    const base = reader ?? treeReader(git, mainSha);
    const layers = overlays.map(({ sha, changedFiles }) => ({ reader: treeReader(git, sha), files: changedFiles }));
    if (!(overlayChangedFiles instanceof Map)) throw new Error('overlayChangedFiles must be a Map');
    const changes = { root: base.root, exists: path => overlayChangedFiles.get(relative(base.root, path)) != null,
      readFile: path => overlayChangedFiles.get(relative(base.root, path)) };
    layers.push({ reader: changes, files: [...overlayChangedFiles.keys()] });
    const combined = layeredReader(base, layers);
    const starts = [...new Set([...entries, ...smokeSurfaceEntries(env)])];
    // The underlying collector permits a missing entry when another exists. Scoping
    // cannot: every caller/smoke root must be proven readable before granting exclusions.
    for (const p of starts) {
      if (!validPath(p) || !combined.exists(p)) return { ok: false, reason: 'entries-unreadable' };
      try { combined.readFile(p); } catch { return { ok: false, reason: 'entries-unreadable' }; }
    }
    let closure = collectRunClosure({ root: combined.root, reader: combined, entries: starts,
      maxFiles: LIMIT, strict: true, stopWhenIncomplete: true });
    if (!closure?.complete) return { ok: false, reason: 'closure-incomplete' };
    if (closure.files.size > LIMIT) return { ok: false, reason: 'closure-too-large' };
    // More edges can shorten the strict walk's generations and hide a legacy hop refusal.
    // Require the independent pre-extension walk too; neither walk may authorize the other.
    const legacy = collectRunClosure({ root: combined.root, reader: combined, entries: starts,
      maxFiles: LIMIT, strict: true, strictExtensions: false, stopWhenIncomplete: true });
    if (!legacy?.complete) return { ok: false, reason: 'closure-incomplete' };
    if (legacy.files.size > LIMIT) return { ok: false, reason: 'closure-too-large' };
    closure = { ...closure, files: new Set([...closure.files, ...legacy.files]),
      bareDeps: closure.bareDeps || legacy.bareDeps,
      jsonNames: new Set([...closure.jsonNames, ...legacy.jsonNames]),
      spawnedNames: new Set([...closure.spawnedNames, ...legacy.spawnedNames]) };
    if (closure.files.size > LIMIT) return { ok: false, reason: 'closure-too-large' };
    const scope = new Set([...closure.files, ...mechanismPaths]);
    for (const p of combined.listFiles()) {
      if (closure.opaqueReads || always(p) || mechanismPaths.some(prefix => under(p, prefix))
        || (p.endsWith('.json') && closure.jsonNames.has(basename(p)))) scope.add(p);
    }
    metadata.set(scope, { mechanismPaths: [...mechanismPaths], jsonNames: new Set(closure.jsonNames) });
    return { ok: true, scope, closure };
  } catch (error) {
    return { ok: false, reason: error.code === 'CLOSURE_TOO_LARGE' ? 'closure-too-large' : 'scope-unreadable' };
  }
}

/** Returns additions without mutation; the future planner owns the maximum three
 * replans. Unknown/incomplete/oversized final evidence must retain the conflict. */
export function fixpointExtend({ scope, excluded, finalClosure }) {
  if (!finalClosure?.complete || !(finalClosure.files instanceof Set) || finalClosure.files.size > LIMIT) {
    throw new Error('final closure unproven; retain conflict');
  }
  return [...new Set(excluded)].filter(p => finalClosure.files.has(p) && !scope.has(p));
}

/** Pre-smoke and persisted-candidate evidence, read from the final Git tree rather than the checkout. */
export function finalClosureScope({ git, sha, entries = [], env = {} }) {
  try {
    entries = typeof entries === 'function' ? entries() : entries;
    if (!Array.isArray(entries) || !entries.length) return { ok: false, reason: 'entries-unreadable' };
    return computeClosureScope({ git, mainSha: sha, entries, env });
  } catch { return { ok: false, reason: 'entries-unreadable' }; }
}
