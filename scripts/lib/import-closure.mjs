/**
 * @file scripts/lib/import-closure.mjs
 * @description #4044 — a script's STATIC import closure (relative `import`/`export … from`/literal `import('…')`),
 *   so the daemon machinery can tell whether a tree move touched code a given process or check actually runs:
 *   `daemon-self-sync.mjs` (restart only when the daemon's own imports changed) and `daemon-live-smoke.mjs`
 *   (re-run a tree-code check only when the code it exercises changed since the last live-verified build).
 *   Its own module so both can import it without a cycle (self-sync already imports the smoke).
 */

import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve as resolvePath, relative, isAbsolute, basename } from 'node:path';

const IMPORT_SPEC_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])([^'"\n]+)\1/g;
const JSON_LITERAL_RE = /['"`]([^'"`\n]*\.json)['"`]/g;
const NONLITERAL_DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*(?!['"])/;

function resolveRelativeSpec(fromFile, spec, exists) {
  const base = resolvePath(dirname(fromFile), spec);
  for (const cand of [base, `${base}.mjs`, `${base}.js`, `${base}.cjs`, `${base}/index.mjs`, `${base}/index.js`]) {
    if (exists(cand)) return cand;
  }
  return null;
}

/**
 * The daemon's STATIC import closure, walked from its entry file(s) over relative `import`/`export … from`/
 * literal `import('…')` specifiers. Returns repo-relative paths. `complete:false` when a closure file has a
 * NON-literal dynamic `import(expr)` in code (its target can't be known statically) — the caller then falls back
 * to "any code file changed". `bareDeps` = some file imports a package (a `package*.json` change is relevant).
 * `jsonNames` = basenames of `.json` string literals in closure files (a config read at runtime by name).
 * Never throws: an unreadable entry returns `null` (the caller's conservative fallback).
 * `parsed` may be shared across walks of the SAME tree snapshot (e.g. successive spawned-script hops).
 * It must be discarded before walking a changed tree; by default every invocation gets a fresh cache.
 * @param {{root:string, entries:string[], readFile?:(p:string)=>string, exists?:(p:string)=>boolean, parsed?:Map}} o
 * @returns {{files:Set<string>, complete:boolean, bareDeps:boolean, jsonNames:Set<string>}|null}
 */
export function collectImportClosure({
  root, entries, readFile = (p) => readFileSync(p, 'utf8'),
  exists = (p) => { try { return statSync(p).isFile(); } catch { return false; } },
  parsed = new Map(),
}) {
  const absRoot = resolvePath(root);
  const starts = (entries || []).filter(Boolean).map((e) => (isAbsolute(e) ? e : resolvePath(absRoot, e)))
    .filter((e) => !relative(absRoot, e).startsWith('..') && exists(e));
  if (!starts.length) return null;
  const seen = new Set();
  const jsonNames = new Set();
  let complete = true;
  let bareDeps = false;
  const stack = [...starts];
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    let info = parsed.get(file);
    if (!info) {
      info = { imports: [], jsonNames: new Set(), complete: true, bareDeps: false };
      let src;
      try { src = readFile(file); } catch { info.complete = false; }
      if (src !== undefined) {
        for (const m of src.matchAll(IMPORT_SPEC_RE)) {
          const spec = m[2];
          if (spec.startsWith('./') || spec.startsWith('../')) {
            const hit = resolveRelativeSpec(file, spec, exists);
            if (hit && !relative(absRoot, hit).startsWith('..')) info.imports.push(hit);
          } else if (!spec.startsWith('node:') && /^[@a-z]/i.test(spec) && !/\s/.test(spec)) {
            info.bareDeps = true;
          }
        }
        for (const m of src.matchAll(JSON_LITERAL_RE)) info.jsonNames.add(basename(m[1]));
        for (const line of src.split('\n')) {
          const t = line.trim();
          if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')) continue;
          if (NONLITERAL_DYNAMIC_IMPORT_RE.test(t.replace(/\/\/.*$/, ''))) { info.complete = false; break; }
        }
      }
      parsed.set(file, info);
    }
    stack.push(...info.imports);
    for (const name of info.jsonNames) jsonNames.add(name);
    complete &&= info.complete;
    bareDeps ||= info.bareDeps;
  }
  return { files: new Set([...seen].map((f) => relative(absRoot, f))), complete, bareDeps, jsonNames };
}


const PACKAGE_MANIFEST_RE = /(^|\/)package(-lock)?\.json$/;

/**
 * PURE: the changed files that fall inside `closure` — a closure member, a `package*.json` when the closure
 * imports any package, or a `.json` whose basename a closure file names as a literal. `null` when the answer is
 * unknowable (no diff, or an incomplete/unknown closure) — every caller treats that as "touched".
 * @param {{closure:ReturnType<typeof collectImportClosure>, changedFiles:string[]|null}} o
 * @returns {string[]|null}
 */
export function closureHits({ closure, changedFiles }) {
  if (!Array.isArray(changedFiles) || !closure || !closure.complete) return null;
  return changedFiles.filter((f) => closure.files.has(f)
    || (closure.bareDeps && PACKAGE_MANIFEST_RE.test(f))
    || (f.endsWith('.json') && closure.jsonNames.has(basename(f))));
}
