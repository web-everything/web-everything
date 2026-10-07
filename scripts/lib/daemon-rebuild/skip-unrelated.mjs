/** @file scripts/lib/daemon-rebuild/skip-unrelated.mjs — the `daemonRebuild.skipUnrelated` knob and the pure
 * decision behind it. When the commits between the clone's verified build and the new target change NO file the
 * daemon imports (its static import closure — the same set the #4044 restart gate uses — UNIONED with everything
 * the shared candidate smoke exercises, see `smokeSurfaceEntries`), no package manifest or lockfile, no config
 * file, and no executable/runtime-read file, the candidate build + live smoke is pointless: the code that runs is
 * identical.
 * The clone is then fast-moved to the target (see `prepareRebuild`) without the ~100-140s smoke.
 * Applies to EVERY daemon that uses daemon-self-sync (drain, review, fix, ...), not only the drain.
 */
import { isCodePath } from '../main-staleness.mjs';
import { closureHits, collectImportClosure } from '../import-closure.mjs';
import { SMOKE_CHECKS } from '../daemon-live-smoke.mjs';
import { DAEMON_ENTRY_MODULES, resolveDaemonEntries } from '../daemon-boot-smoke.mjs';
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
// A file a daemon can RUN or READ without statically importing it: a spawned shell/python/etc. script, a
// workflow/config file, anything under the skill/prompt trees (read at runtime). None is in an import closure, so
// "not in the closure" must never be read as "cannot change what runs" for these — they always take the smoke.
const EXECUTABLE_RE = /\.(sh|bash|zsh|py|rb|pl|ya?ml|toml|html?|mts|cts|tsx|jsx)$/i;
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
export function makeSkipCheck({
  root, entries, env = process.env, importClosure = collectImportClosure, surface = smokeSurfaceEntries,
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
      try { closure = own.length ? importClosure({ root, entries: [...own, ...smoked] }) : null; } catch { closure = null; }
      // The walk drops an entry that does not exist in the PRE-move tree, so a smoke-surface file the move itself
      // ADDS would read as unrelated: name every surface path as a closure member regardless.
      if (closure?.files instanceof Set) for (const e of smoked) closure.files.add(e);
    }
    return decideSkipRebuild({ changedFiles, closure });
  };
}
