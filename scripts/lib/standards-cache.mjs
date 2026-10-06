// Per-file result cache for check:standards (perf item 70a). Module + key only; sections are wired in 70b.
// Safety rules: any doubt -> recompute (cache off / miss). CI never reads or writes it. A section's
// results are written only by commit() after a complete run; a crash (abort / no commit) writes nothing.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, statSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

const sha = (s) => createHash('sha256').update(s).digest('hex');

/** Cache is off when WE_STANDARDS_CACHE=0 or when CI is set (merged-tree authority never uses it). */
export function cacheEnabled(env = process.env) {
  if (env.WE_STANDARDS_CACHE === '0') return false;
  if (env.CI) return false;
  return true;
}

export function cacheDir(env = process.env) {
  return env.WE_STANDARDS_CACHE_DIR || join(homedir(), '.cache', 'we-standards');
}

/**
 * Map of tracked/untracked-not-ignored path -> content key. Clean tracked files use the index blob SHA
 * (free from one `git ls-files -s`); modified or untracked files are hashed with `git hash-object`.
 */
export function fileKeys(root) {
  const git = (args, input) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28, input });
  const keys = new Map();
  for (const line of git(['ls-files', '-s', '-z']).split('\0')) {
    const m = /^\d+ ([0-9a-f]+) \d\t(.+)$/.exec(line);
    if (m) keys.set(m[2], m[1]);
  }
  const dirty = new Set();
  for (const f of git(['diff', '--name-only', '-z']).split('\0')) if (f) dirty.add(f);
  for (const f of git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0')) if (f) dirty.add(f);
  const gone = [];
  const toHash = [];
  for (const f of dirty) (existsSync(join(root, f)) ? toHash : gone).push(f);
  for (const f of gone) keys.delete(f);
  if (toHash.length) {
    const out = git(['hash-object', '--stdin-paths'], toHash.join('\n') + '\n').trim().split('\n');
    toHash.forEach((f, i) => keys.set(f, out[i]));
  }
  return keys;
}

const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"](\.{1,2}\/[^'"\n]+)['"]/gm;
// Whole-line // comments are skipped (block comments are NOT stripped: a `/*` inside a string could hide a real import) so prose that mentions an import cannot trigger a lookup.
const stripComments = (src) => src.replace(/^\s*\/\/.*$/gm, '');

/** Static import closure of an entry file (relative specifiers only). Throws on an unresolvable or non-file one; non-JS files are hashed, not walked. */
export function importClosure(entry) {
  const seen = new Map();
  const walk = (file) => {
    if (seen.has(file)) return;
    const src = readFileSync(file, 'utf8');
    seen.set(file, src);
    for (const m of stripComments(src).matchAll(IMPORT_RE)) {
      const target = resolve(dirname(file), m[1]);
      if (!existsSync(target)) throw new Error(`unresolved import ${m[1]} from ${file}`);
      if (!statSync(target).isFile()) throw new Error(`import ${m[1]} from ${file} is not a file`);
      if (/\.(mjs|cjs|js)$/.test(target)) walk(target);
      else if (!seen.has(target)) seen.set(target, readFileSync(target)); // data import (e.g. JSON): hash its bytes, do not parse it
    }
  };
  walk(resolve(entry));
  return seen;
}

const closureMemo = new Map();

/**
 * Rule version for one section: sha256 of section id + contents of the entry modules and everything they
 * import + node major. Returns null (cache off) when the closure cannot be resolved with confidence.
 */
export function ruleVersion(sectionId, entries, { nodeMajor = process.versions.node.split('.')[0] } = {}) {
  try {
    const files = new Map();
    for (const e of entries) {
      const memoKey = resolve(e);
      let c = closureMemo.get(memoKey);
      if (!c) { c = importClosure(e); closureMemo.set(memoKey, c); }
      for (const [f, s] of c) files.set(f, s);
    }
    const h = createHash('sha256').update(`${sectionId}\0node${nodeMajor}\0`);
    for (const f of [...files.keys()].sort()) h.update(f).update('\0').update(sha(files.get(f))).update('\0');
    return h.digest('hex');
  } catch {
    return null;
  }
}

export function resetClosureMemo() { closureMemo.clear(); }

/**
 * One section's cache. lookup(key) -> findings[] | undefined; record(key, findings) buffers; commit() writes
 * the merged map atomically (call only after the whole section finished); abort()/never committing writes nothing.
 */
export function openSectionCache({ section, version, env = process.env }) {
  const enabled = cacheEnabled(env) && !!version;
  const file = enabled ? join(cacheDir(env), version, `${section.replace(/[^\w.-]/g, '_')}.json`) : null;
  let stored = {};
  if (enabled && existsSync(file)) {
    try { stored = JSON.parse(readFileSync(file, 'utf8')); } catch { stored = {}; }
  }
  const pending = {};
  const stats = { hits: 0, misses: 0 };
  let done = false;
  return {
    enabled,
    stats,
    lookup(key) {
      if (enabled && key && Object.hasOwn(stored, key)) { stats.hits++; return stored[key]; }
      stats.misses++;
      return undefined;
    },
    record(key, findings) { if (enabled && key && !done) pending[key] = findings; },
    // keep: optional Set of keys still live; stored entries outside it are dropped (a whole-tree section would otherwise grow without bound).
    commit(keep) {
      if (!enabled || done) return false;
      done = true;
      let merged = { ...stored, ...pending };
      let pruned = false;
      if (keep) {
        const live = {};
        for (const k of Object.keys(merged)) if (keep.has(k)) live[k] = merged[k];
        pruned = Object.keys(live).length !== Object.keys(stored).length;
        merged = live;
      }
      if (!Object.keys(pending).length && !pruned) return false;
      try {
        mkdirSync(dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify(merged));
        renameSync(tmp, file);
        return true;
      } catch { return false; }
    },
    abort() { done = true; },
    profileLine() { return `${section}: ${stats.hits} hit / ${stats.misses} miss`; },
  };
}

/**
 * Per-file cached scan for a section whose scanner judges each doc's OWN content only (perf item 70b).
 * `files` = labels (repo-relative paths), `load(file)` reads the content, `scan(docs)` is the section's
 * pure scanner (docs -> findings, each carrying `.file`). Cached files replay stored findings; misses are
 * scanned together in ONE call and attributed by `.file`. Findings come back grouped in `files` order, which
 * equals the uncached scan's order because the scanner iterates docs in order. Any doubt (cache off, no
 * version, key lookup failed, a finding with a foreign `.file`) -> plain uncached scan, nothing recorded.
 * `getKeys()` -> Map(path -> blob sha) (memoized by the caller); a throw means "no keys".
 */
export function scanFilesCached({ section, entries, files, load, scan, getKeys, env = process.env, onStats }) {
  const plain = () => scan(files.map((file) => ({ file, content: load(file) })));
  let cache;
  let keys;
  try {
    if (!cacheEnabled(env)) return plain();
    cache = openSectionCache({ section, version: ruleVersion(section, entries), env });
    if (!cache.enabled) return plain();
    keys = getKeys();
  } catch { return plain(); }
  const keyOf = (f) => (keys.has(f) ? `${f}\0${keys.get(f)}` : null);
  const perFile = new Map();
  const misses = [];
  for (const f of files) {
    const hit = keyOf(f) && cache.lookup(keyOf(f));
    if (hit) perFile.set(f, hit); else { if (!keyOf(f)) cache.stats.misses++; misses.push(f); }
  }
  let fresh = [];
  try {
    fresh = scan(misses.map((file) => ({ file, content: load(file) })));
  } catch (e) { cache.abort(); throw e; }
  const byFile = new Map(misses.map((f) => [f, []]));
  for (const finding of fresh) {
    if (!byFile.has(finding.file)) { cache.abort(); return plain(); }
    byFile.get(finding.file).push(finding);
  }
  for (const f of misses) { perFile.set(f, byFile.get(f)); if (keyOf(f)) cache.record(keyOf(f), byFile.get(f)); }
  cache.commit();
  if (onStats) onStats(cache.profileLine());
  return files.flatMap((f) => perFile.get(f));
}

const GREP_CHUNK = 1500;

/**
 * Cached `git grep -nE <pattern> -- . <excludes>` (perf item 70c). The raw hit lines of a file are a pure function of
 * that file's content + the pattern, so they are cached per file (key = path + content key) and only files with no
 * cached entry are grepped (in chunks, literal pathspecs). Returns the SAME lines, in the same order, as one whole-tree
 * `git grep --threads=1` would: tracked files in index order, each file's lines in line order. `exclude(path)` mirrors
 * the caller's `:!dir` pathspecs. Any doubt (cache off, no version, no keys, a line that cannot be attributed to a
 * tracked file, a grep failure other than "no match") -> returns null and the caller runs its own plain git grep.
 * Whole-tree classification (what a hit MEANS) stays with the caller and is never cached.
 */
export function gitGrepCached({ section, entries, root, pattern, exclude = () => false, getKeys, env = process.env, onStats }) {
  try {
    if (!cacheEnabled(env)) return null;
    const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] });
    const base = ruleVersion(section, entries);
    if (!base) return null;
    const version = sha(`${base}\0${pattern}\0${git(['--version'])}`);
    const cache = openSectionCache({ section, version, env });
    if (!cache.enabled) return null;
    const keys = getKeys();
    const tracked = git(['ls-files', '-z']).split('\0').filter((f) => f && !exclude(f) && keys.has(f));
    const keyOf = (f) => `${f}\0${keys.get(f)}`;
    const perFile = new Map();
    const misses = [];
    for (const f of tracked) {
      const hit = cache.lookup(keyOf(f));
      if (hit) perFile.set(f, hit); else misses.push(f);
    }
    const known = new Set(tracked);
    for (let i = 0; i < misses.length; i += GREP_CHUNK) {
      const chunk = misses.slice(i, i + GREP_CHUNK);
      let out = '';
      try {
        out = execFileSync('git', ['--literal-pathspecs', 'grep', '--threads=1', '-nE', pattern, '--', ...chunk],
          { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 28 });
      } catch (e) { if (e?.status !== 1) { cache.abort(); return null; } }
      const byFile = new Map(chunk.map((f) => [f, []]));
      for (const line of out.split('\n')) {
        if (!line) continue;
        let file = null;
        for (let c = line.indexOf(':'); c !== -1; c = line.indexOf(':', c + 1)) {
          const cand = line.slice(0, c);
          if (known.has(cand) && byFile.has(cand) && /^\d+:/.test(line.slice(c + 1))) { file = cand; break; }
        }
        if (!file) { cache.abort(); return null; }
        byFile.get(file).push(line);
      }
      for (const f of chunk) { perFile.set(f, byFile.get(f)); cache.record(keyOf(f), byFile.get(f)); }
    }
    cache.commit(new Set(tracked.map(keyOf)));
    if (onStats) onStats(cache.profileLine());
    return tracked.flatMap((f) => perFile.get(f));
  } catch { return null; }
}
