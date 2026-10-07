/** @file scripts/lib/daemon-rebuild/skip-unrelated.mjs — the `daemonRebuild.skipUnrelated` knob and the pure
 * decision behind it. When the commits between the clone's verified build and the new target change NO file the
 * daemon imports (its static import closure — the same set the #4044 restart gate uses — UNIONED with everything
 * the shared candidate smoke exercises, see `smokeSurfaceEntries`, plus every script those files spawn by path, see
 * `collectRunClosure`), no package manifest or lockfile, no config
 * file, and no executable/runtime-read file, the candidate build + live smoke is pointless: the code that runs is
 * identical.
 * The clone is then fast-moved to the target (see `prepareRebuild`) without the ~100-140s smoke.
 * Applies to EVERY daemon that uses daemon-self-sync (drain, review, fix, ...), not only the drain.
 */
import { isCodePath } from '../main-staleness.mjs';
import { closureHits, collectImportClosure } from '../import-closure.mjs';
import { SMOKE_CHECKS } from '../daemon-live-smoke.mjs';
import { DAEMON_ENTRY_MODULES, resolveDaemonEntries } from '../daemon-boot-smoke.mjs';
import { readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath } from 'node:path';

/** Env override: `0`/`false` turns the skip off, `1`/`true` on. Unset = the settings file (default on). */
export const SKIP_UNRELATED_ENV = 'WE_DAEMON_REBUILD_SKIP_UNRELATED';

export function daemonRebuildSettingsPath() {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'daemon-rebuild-settings.json');
}

/** `daemonRebuild.skipUnrelated` — default ON; env beats file; anything malformed keeps the default. */
export function resolveSkipUnrelated(env = process.env, { path = daemonRebuildSettingsPath() } = {}) {
  const e = String(env?.[SKIP_UNRELATED_ENV] ?? '').trim().toLowerCase();
  if (e === '0' || e === 'false') return false;
  if (e === '1' || e === 'true') return true;
  try {
    const v = JSON.parse(readFileSync(path, 'utf8'))?.daemonRebuild?.skipUnrelated;
    if (typeof v === 'boolean') return v;
  } catch { /* missing/corrupt file = default */ }
  return true;
}

const MANIFEST_RE = /(^|\/)(package(-lock)?\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/;
const CONFIG_RE = /(^|\/)(\.nvmrc|\.node-version|\.npmrc|daemon-[a-z-]*settings\.json)$/;
// A file a daemon can RUN or READ without statically importing it: a spawned shell/python/etc. script, a
// workflow/config file, anything under the skill/prompt trees (read at runtime). None is in an import closure, so
// "not in the closure" must never be read as "cannot change what runs" for these — they always take the smoke.
const EXECUTABLE_RE = /\.(sh|bash|zsh|py|rb|pl|ya?ml|toml|html?|ts|mts|cts|tsx|jsx)$/i;
const RUNTIME_READ_RE = /^(skills-src|\.claude)\//;

/**
 * The files the candidate smoke itself exercises, beyond the calling daemon's own entries: every
 * `SMOKE_CHECKS` row's `codeEntries`, every daemon entry the boot check imports (the real list AND any
 * `WE_SMOKE_DAEMON_ENTRIES` override), and the two smoke modules. The clone — and its single adopted head — is
 * shared by every daemon, so a move that changes only a SIBLING daemon's code or a smoke-checked script must still
 * be smoked: the skip may not look at the calling daemon's closure alone. Built from the smoke's own exports so
 * the two cannot drift apart.
 */
export function smokeSurfaceEntries(env = process.env) {
  const out = new Set(['scripts/lib/daemon-live-smoke.mjs', 'scripts/lib/daemon-boot-smoke.mjs', ...DAEMON_ENTRY_MODULES]);
  for (const e of resolveDaemonEntries(env).entries) out.add(e);
  for (const check of SMOKE_CHECKS) for (const e of check.codeEntries || []) out.add(e);
  return [...out];
}

// A script file NAMED inside a string/template literal in code a daemon runs: `spawn(process.execPath,
// [new URL('./x.mjs', import.meta.url).pathname])`, `join(__dirname, 'x.mjs')`, `join(ROOT, 'scripts', 'x.mjs')`,
// `fork('./x.js')`, `exec('node scripts/x.mjs --flag')`, an `npm run` entry in package.json. No `import` names it,
// so the static closure cannot see it, yet the daemon runs it. The token may be followed by arguments or a query.
const STRING_RE = /(['"`])([^'"`\n]*)\1/g;
const SCRIPT_TOKEN_RE = /[^\s'"`()<>|;&=,]*\.(?:mjs|cjs|js|ts)(?=$|[\s?#:])/g;
const NOT_WALKED_RE = /(^|\/)(node_modules|__tests__)\/|\.(test|spec)\.[cm]?[jt]s$/;
const MAX_SPAWN_HOPS = 64;

/** One comparison form for a name/path: git reports NFC-or-not, the clone's filesystem may be case-insensitive. */
const norm = (s) => s.normalize('NFC').toLowerCase();

/** Lazily-built index of tracked script files by normalized basename (git ls-files; `[]` when git is unavailable). */
function trackedScriptIndex(root) {
  let index = null;
  return (name) => {
    if (!index) {
      index = new Map();
      const r = spawnSync('git', ['-c', 'core.quotepath=off', 'ls-files', '-z', '--', '*.mjs', '*.cjs', '*.js', '*.ts'], {
        cwd: root, encoding: 'utf8', timeout: 20_000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024,
      });
      if (r.status === 0) {
        for (const p of r.stdout.split('\0').filter(Boolean)) {
          const k = norm(basename(p));
          (index.get(k) || index.set(k, []).get(k)).push(p);
        }
      }
    }
    return index.get(norm(name)) || [];
  };
}

/**
 * Scripts the closure's files run by path. `targets` = tokens that resolve to a real file inside `root` (next to
 * the naming file, repo-relative, or — when the path is assembled from pieces and names no real file — EVERY tracked
 * file with that basename); each is walked as a new entry, so a spawned script's own imports and own spawns are
 * covered too. `names` = the normalized basename of EVERY such token, including ones that resolve to nothing in the
 * pre-move tree (a spawned script the move itself adds): a changed code file with that basename is relevant.
 * `unreadable` = a file could not be read (the closure must then be reported incomplete).
 */
function collectSpawnedScripts({ root, files, readFile, exists, byName }) {
  const targets = new Set();
  const names = new Set();
  let unreadable = false;
  const accept = (rel) => {
    if (rel.startsWith('..') || isAbsolute(rel) || NOT_WALKED_RE.test(rel)) return false;
    targets.add(rel);
    return true;
  };
  for (const file of files) {
    let src;
    try { src = readFile(join(root, file)); } catch { unreadable = true; continue; }
    for (const line of src.split('\n')) {
      // Drop a leading block comment, then a line that is wholly prose; code after `/* x */` still counts.
      const t = line.replace(/^\s*\/\*.*?\*\//, '').trim();
      if (!t || t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')) continue;
      for (const s of t.matchAll(STRING_RE)) {
        for (const tok of s[2].matchAll(SCRIPT_TOKEN_RE)) {
          const lit = tok[0];
          const base = basename(lit);
          names.add(norm(base));
          let resolved = false;
          for (const cand of [resolvePath(root, dirname(file), lit), resolvePath(root, lit)]) {
            if (exists(cand) && accept(relative(root, cand))) resolved = true;
          }
          if (!resolved) for (const p of byName(base)) accept(p);
        }
      }
    }
  }
  return { targets, names, unreadable };
}

/**
 * The import closure of `entries` PLUS every script those files spawn by path, to a fixed point (each file is
 * scanned once; the walk ends when no new script appears, bounded by `MAX_SPAWN_HOPS` — past it the closure is
 * reported incomplete so the caller falls back to "any code file"). Returns the closure with `spawnedNames`
 * (see {@link collectSpawnedScripts}), or `null` when the walk has no usable entry.
 */
export function collectRunClosure({
  root, entries, importClosure = collectImportClosure,
  readFile = (p) => readFileSync(p, 'utf8'),
  exists = (p) => { try { return statSync(p).isFile(); } catch { return false; } },
  byName = trackedScriptIndex(resolvePath(root)),
}) {
  const absRoot = resolvePath(root);
  const walked = new Set(entries);
  let closure = importClosure({ root, entries: [...walked] });
  if (!closure) return null;
  const spawnedNames = new Set();
  const scanned = new Set();
  let unreadable = false;
  for (let hop = 0; ; hop++) {
    // package.json's `scripts` entries are commands the daemon (or its npm wrappers) run by name.
    const unscanned = [...closure.files, ...(hop === 0 && exists(join(absRoot, 'package.json')) ? ['package.json'] : [])]
      .filter((f) => !scanned.has(f));
    for (const f of unscanned) scanned.add(f);
    const { targets, names, unreadable: bad } = collectSpawnedScripts({ root: absRoot, files: unscanned, readFile, exists, byName });
    unreadable ||= bad;
    for (const n of names) spawnedNames.add(n);
    const fresh = [...targets].filter((t) => !closure.files.has(t) && !walked.has(t));
    if (!fresh.length) break;
    if (hop >= MAX_SPAWN_HOPS) { closure = { ...closure, complete: false }; break; }
    for (const t of fresh) walked.add(t);
    closure = importClosure({ root, entries: [...walked] }) || closure;
  }
  return { ...closure, complete: closure.complete && !unreadable, spawnedNames };
}

/**
 * PURE: may the candidate build + smoke be skipped for this change set?
 * Never skips when the diff is unknown, or when any changed file is a package manifest/lockfile, a daemon or
 * node config file, an executable/runtime-read file that no import closure can see, or a file in the closure.
 * An incomplete closure (a non-literal dynamic import) falls back to "any code file" exactly like the restart gate.
 * @returns {{skip:boolean, reason:string, relevant?:string[]}}
 */
export function decideSkipRebuild({ changedFiles, closure }) {
  if (!Array.isArray(changedFiles)) return { skip: false, reason: 'diff-unknown' };
  if (!changedFiles.length) return { skip: false, reason: 'no-change' };
  const manifest = changedFiles.filter((f) => MANIFEST_RE.test(f) || CONFIG_RE.test(f));
  if (manifest.length) return { skip: false, reason: 'manifest-or-config-change', relevant: manifest };
  const runtime = changedFiles.filter((f) => EXECUTABLE_RE.test(f) || RUNTIME_READ_RE.test(f));
  if (runtime.length) return { skip: false, reason: 'executable-or-runtime-file-change', relevant: runtime };
  let relevant = closure && closure.complete ? closureHits({ closure, changedFiles }) : changedFiles.filter(isCodePath);
  // A script the closure's files run by path (spawn/fork/new URL) is code that runs though nothing imports it.
  if (relevant && closure?.complete && closure.spawnedNames?.size) {
    const spawned = changedFiles.filter((f) => /\.(mjs|cjs|js)$/i.test(f) && closure.spawnedNames.has(norm(basename(f))) && !relevant.includes(f));
    if (spawned.length) relevant = [...relevant, ...spawned];
  }
  // The same path compared as text in two places (closure vs git's spelling): fold case and Unicode form.
  if (relevant && closure?.complete && closure.files instanceof Set) {
    const members = new Set([...closure.files].map(norm));
    const folded = changedFiles.filter((f) => members.has(norm(f)) && !relevant.includes(f));
    if (folded.length) relevant = [...relevant, ...folded];
  }
  if (!relevant || relevant.length) return { skip: false, reason: 'imported-change', relevant: relevant || [] };
  return { skip: true, reason: `none of ${changedFiles.length} changed file(s) is imported by this daemon, a manifest, lockfile or config`, relevant: [] };
}

/**
 * The default `skipCheck` for {@link rebuildClone}: `null` when the knob is off, else a function over the changed
 * files. The closure is walked lazily, once, from `entries` (the daemon's own entry file(s), inside `root`); with
 * no usable entry it is `null` and the decision falls back to "any code file changed" — exactly the #4044 restart
 * gate's fallback — so docs/backlog/markdown-only moves still skip.
 */
export function makeSkipCheck({
  root, entries, env = process.env, importClosure = collectImportClosure, surface = smokeSurfaceEntries,
  readFile, exists,
}) {
  if (!resolveSkipUnrelated(env)) return null;
  let built = false;
  let closure = null;
  return (changedFiles) => {
    if (!built) {
      built = true;
      // The closure is the caller's entries UNION the whole smoke surface (see smokeSurfaceEntries). With no
      // caller entry the closure stays unknown (null) and the decision falls back to "any code file changed".
      const own = (entries || []).filter(Boolean);
      const smoked = surface(env);
      try { closure = own.length ? collectRunClosure({ root, entries: [...own, ...smoked], importClosure, readFile, exists }) : null; } catch { closure = null; }
      // The walk drops an entry that does not exist in the PRE-move tree, so a smoke-surface file the move itself
      // ADDS would read as unrelated: name every surface path as a closure member regardless.
      if (closure?.files instanceof Set) for (const e of smoked) closure.files.add(e);
    }
    return decideSkipRebuild({ changedFiles, closure });
  };
}
