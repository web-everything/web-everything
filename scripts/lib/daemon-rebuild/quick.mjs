/** Quick rebuild policy. Decisions are pure; only the setting resolver reads policy files. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closureHits } from '../import-closure.mjs';
import { cascadePolicy } from '../policy-cascade.mjs';
import { DISPATCH_DRY_RUN_CODE_ENTRIES } from '../daemon-live-smoke.mjs';

export const QUICK_ENV = 'WE_DAEMON_REBUILD_QUICK';
export const QUICK_DEFERRED_CHECKS = Object.freeze(['dispatch-dry-run', 'reconcile-dry-run']);
export const QUICK_SOAK_CHECKS = Object.freeze([...QUICK_DEFERRED_CHECKS, 'tree-stays-clean']);
/** One authoritative protected path list; dispatch entries also expand to their import closure. */
export const QUICK_ALWAYS_FULL_PATHS = Object.freeze([
  'scripts/lib/daemon-rebuild/**',
  'scripts/lib/daemon-rebuild*.mjs',
  'scripts/lib/daemon-live-smoke.mjs',
  'scripts/lib/daemon-boot-smoke.mjs',
  ...DISPATCH_DRY_RUN_CODE_ENTRIES,
]);
export const QUICK_SOAK_MAX_MS = 60 * 60_000;
const SETTINGS_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'daemon-rebuild-settings.json');

/** Same tool block as skipUnrelated, with all four cascade layers and standard provenance logging. */
export function resolveQuick(env = process.env, { path = SETTINGS_PATH, platform, log } = {}) {
  let tool;
  try { tool = { quick: JSON.parse(readFileSync(path, 'utf8'))?.daemonRebuild?.quick }; } catch { /* unset */ }
  const raw = env?.[QUICK_ENV];
  const r = cascadePolicy('daemonRebuild', tool, {
    env, platform, log, standard: { quick: false },
    envValues: { quick: raw === '1' ? true : raw === '0' ? false : undefined },
    valid: { quick: value => typeof value === 'boolean' },
  });
  return { quick: r.value.quick === true, source: r.sources.quick };
}

const safePath = path => typeof path === 'string' && path.length > 0 && path.length <= 4096 && !path.startsWith('/')
  && !path.includes('\\') && !path.split('/').some(part => part === '..' || part === '.') && !/[\p{Cc}\p{Cf}]/u.test(path);
const matches = (path, pattern) => {
  const escaped = pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${escaped.join('.*')}$`).test(path);
};

/** Unknown or oversized evidence falls back to full smoke; callers log this reason when enabled. */
export function decideQuick({ enabled = false, changedFiles, dispatchClosure } = {}) {
  if (enabled !== true) return { quick: false, why: 'disabled' };
  if (!Array.isArray(changedFiles) || changedFiles.length > 10_000 || !changedFiles.every(safePath)) {
    return { quick: false, why: 'unknown or oversized change set — full smoke required' };
  }
  const dispatchFiles = dispatchClosure?.files instanceof Set ? dispatchClosure.files : null;
  const dependencyEvidence = typeof dispatchClosure?.bareDeps === 'boolean' && dispatchClosure?.jsonNames instanceof Set;
  const protectedPath = changedFiles.find(path => QUICK_ALWAYS_FULL_PATHS.some(pattern => matches(path, pattern))
    || dispatchFiles?.has(path));
  if (protectedPath) return { quick: false, why: `protected code changed: ${protectedPath}` };
  if (dispatchClosure?.complete !== true || !dispatchFiles
    || !dependencyEvidence
    || !DISPATCH_DRY_RUN_CODE_ENTRIES.every(entry => dispatchFiles.has(entry))) {
    return { quick: false, why: 'unknown dispatch import closure — full smoke required' };
  }
  const dependencyHit = closureHits({ closure: dispatchClosure, changedFiles })?.[0];
  if (dependencyHit) return { quick: false, why: `protected code changed: ${dependencyHit}` };
  return { quick: true, why: 'two dry-run checks deferred to post-adopt soak' };
}

/** Retain the full path's existing max/starvation and explicit test override semantics. */
export function quickFinalizeWaitMs({ quick = false, env = process.env, waitMs = 0, overrideWaitMs } = {}) {
  const explicit = Number(env?.WE_DAEMON_FINALIZE_LOCK_WAIT_MS);
  const finalize = Number.isFinite(explicit) && explicit > 0 ? explicit : quick ? 60_000 : 180_000;
  return overrideWaitMs ?? (quick ? finalize : Math.max(waitMs, finalize));
}

/** Only fresh, complete evidence from both dry runs and a final clean-tree check verifies adoption. */
export function decideQuickSoakResult(result) {
  const rows = result?.results;
  if (result?.disabled || !Array.isArray(rows) || rows.length !== QUICK_SOAK_CHECKS.length
    || rows.at(-1)?.name !== 'tree-stays-clean'
    || !QUICK_SOAK_CHECKS.every(name => rows.filter(row => row?.name === name
      && typeof row.ok === 'boolean' && !row.skipped && !row.skipReason).length === 1)) return 'unavailable';
  if (rows.some(row => !row.ok)) return 'failed';
  return result.pass === true ? 'passed' : 'unavailable';
}
