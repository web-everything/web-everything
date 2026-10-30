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

/** Exclusion requires proof issued for this exact snapshot scope. Unknown paths, copied
 * or caller-created sets and persisted membership alone never authorize dropping a file.
 * Membership still wins so the planner can extend protection during its fixpoint. */
export function isExcludable(path, scope) {
  if (!validPath(path) || !(scope instanceof Set) || scope.has(path) || always(path)) return false;
  return metadata.get(scope)?.exclusions.has(path) === true;
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
    // Decide compatibility before strict expansion can add shortcuts. Keep BOTH historical
    // graphs independent: adding even single-target require edges can shorten the older walk.
    const legacy = collectRunClosure({ root: combined.root, reader: combined, entries: starts,
      maxFiles: LIMIT, strict: true, strictExtensions: false, stopWhenIncomplete: true });
    if (!legacy?.complete) return { ok: false, reason: 'closure-incomplete' };
    if (legacy.files.size > LIMIT) return { ok: false, reason: 'closure-too-large' };
    const legacyRequire = collectRunClosure({ root: combined.root, reader: combined, entries: starts,
      maxFiles: LIMIT, strict: true, strictExtensions: false, legacyRequires: true, stopWhenIncomplete: true });
    if (!legacyRequire?.complete) return { ok: false, reason: 'closure-incomplete' };
    if (legacyRequire.files.size > LIMIT) return { ok: false, reason: 'closure-too-large' };
    let closure = collectRunClosure({ root: combined.root, reader: combined, entries: starts,
      maxFiles: LIMIT, strict: true, stopWhenIncomplete: true });
    if (!closure?.complete) return { ok: false, reason: 'closure-incomplete' };
    if (closure.files.size > LIMIT) return { ok: false, reason: 'closure-too-large' };
    closure = { ...closure, files: new Set([...closure.files, ...legacy.files, ...legacyRequire.files]),
      bareDeps: closure.bareDeps || legacy.bareDeps || legacyRequire.bareDeps,
      opaqueReads: closure.opaqueReads !== false || Boolean(legacy.opaqueReads || legacyRequire.opaqueReads),
      referenceTexts: new Map([...legacy.referenceTexts || [], ...legacyRequire.referenceTexts || [],
        ...closure.referenceTexts || []]),
      jsonNames: new Set([...closure.jsonNames, ...legacy.jsonNames, ...legacyRequire.jsonNames]),
      spawnedNames: new Set([...closure.spawnedNames, ...legacy.spawnedNames, ...legacyRequire.spawnedNames]) };
    if (closure.files.size > LIMIT) return { ok: false, reason: 'closure-too-large' };
    // A complete import walk is necessary but insufficient. Every closure file and entry
    // must also provide textual evidence; a missing source or opaque read protects ALL files.
    const opaque = Boolean(closure.opaqueReads) || [...closure.files, ...starts]
      .some(p => typeof closure.referenceTexts.get(p) !== 'string');
    const texts = [...closure.referenceTexts.values()].map(text => text.normalize('NFC').toLowerCase());
    const exclusions = new Set();
    const scope = new Set([...closure.files, ...mechanismPaths]);
    for (const p of combined.listFiles()) {
      // Raw source plus decoded literals protect path, extensionless path and basename
      // substrings without needing another inventory of loader spellings.
      const stem = p.replace(PARSEABLE_CODE_RE, '').normalize('NFC').toLowerCase();
      const mentioned = !opaque && texts.some(text => text.includes(p.normalize('NFC').toLowerCase())
        || text.includes(stem) || text.includes(basename(stem)));
      const eligible = isCodePath(p) || /(^|\/)(__tests__|tests)\//.test(p)
        || /\.(test|spec)\.[cm]?[jt]sx?$/.test(p) || p.startsWith('backlog/');
      if (opaque || !validPath(p) || scope.has(p) || always(p) || mentioned || !eligible
        || mechanismPaths.some(prefix => under(p, prefix))) scope.add(p);
      else exclusions.add(p);
    }
    metadata.set(scope, { exclusions });
    // ok:true remains compatible with read-capability callers: scope contains every
    // snapshot file and the allowlist is empty, so the caller retains the full conflict.
    return { ok: true, scope, closure, ...(opaque ? { reason: 'closure-opaque' } : {}) };
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
