/** @file scripts/lib/daemon-rebuild/skip-unrelated.mjs — the `daemonRebuild.skipUnrelated` knob and the pure
 * decision behind it. When the commits between the clone's verified build and the new target change NO file the
 * daemon imports (its static import closure — the same set the #4044 restart gate uses), no package manifest or
 * lockfile, and no config file, the candidate build + live smoke is pointless: the code that runs is identical.
 * The clone is then fast-moved to the target (see `prepareRebuild`) without the ~100-140s smoke.
 * Applies to EVERY daemon that uses daemon-self-sync (drain, review, fix, ...), not only the drain.
 */
import { isCodePath } from '../main-staleness.mjs';
import { closureHits, collectImportClosure } from '../import-closure.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

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

/**
 * PURE: may the candidate build + smoke be skipped for this change set?
 * Never skips when the diff is unknown, or when any changed file is a package manifest/lockfile, a daemon or
 * node config file, or a file in the daemon's import closure. An incomplete closure (a non-literal dynamic
 * import) falls back to "any code file" exactly like the restart gate.
 * @returns {{skip:boolean, reason:string, relevant?:string[]}}
 */
export function decideSkipRebuild({ changedFiles, closure }) {
  if (!Array.isArray(changedFiles)) return { skip: false, reason: 'diff-unknown' };
  if (!changedFiles.length) return { skip: false, reason: 'no-change' };
  const manifest = changedFiles.filter((f) => MANIFEST_RE.test(f) || CONFIG_RE.test(f));
  if (manifest.length) return { skip: false, reason: 'manifest-or-config-change', relevant: manifest };
  const relevant = closure && closure.complete ? closureHits({ closure, changedFiles }) : changedFiles.filter(isCodePath);
  if (!relevant || relevant.length) return { skip: false, reason: 'imported-change', relevant: relevant || [] };
  return { skip: true, reason: `none of ${changedFiles.length} changed file(s) is imported by this daemon, a manifest, lockfile or config`, relevant: [] };
}

/**
 * The default `skipCheck` for {@link rebuildClone}: `null` when the knob is off, else a function over the changed
 * files. The closure is walked lazily, once, from `entries` (the daemon's own entry file(s), inside `root`); with
 * no usable entry it is `null` and the decision falls back to "any code file changed" — exactly the #4044 restart
 * gate's fallback — so docs/backlog/markdown-only moves still skip.
 */
export function makeSkipCheck({ root, entries, env = process.env, importClosure = collectImportClosure }) {
  if (!resolveSkipUnrelated(env)) return null;
  let built = false;
  let closure = null;
  return (changedFiles) => {
    if (!built) {
      built = true;
      try { closure = importClosure({ root, entries }); } catch { closure = null; }
    }
    return decideSkipRebuild({ changedFiles, closure });
  };
}
