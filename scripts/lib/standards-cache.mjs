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
    commit() {
      if (!enabled || done) return false;
      done = true;
      if (!Object.keys(pending).length) return false;
      try {
        mkdirSync(dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify({ ...stored, ...pending }));
        renameSync(tmp, file);
        return true;
      } catch { return false; }
    },
    abort() { done = true; },
    profileLine() { return `${section}: ${stats.hits} hit / ${stats.misses} miss`; },
  };
}
