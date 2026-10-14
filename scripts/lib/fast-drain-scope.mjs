import { cascadePolicy } from './policy-cascade.mjs';
import { readDeclaredSettings } from './settings-files.mjs';

/** The cwd-repo sentinel must share the full pass's persistent cache namespace. */
export function shaCacheRepo(repo, localSlug) {
  return repo || localSlug;
}

/** Resolve standard → platform → tool → env; injected layers keep unit probes deterministic. */
export function resolveFastDrainScopeSetting({ env = process.env, tool, platform, readSettings = readDeclaredSettings } = {}) {
  let block = tool;
  if (block === undefined) {
    try { block = readSettings().settings?.mergeQueue?.fastDrain; } catch { block = undefined; }
  }
  const raw = String(env?.WE_FAST_DRAIN_SCOPE ?? '').trim().toLowerCase();
  const c = cascadePolicy('mergeQueue.fastDrain', block, {
    env, standard: { scope: 'target' }, envValues: { scope: raw || undefined },
    valid: { scope: (v) => v === 'target' || v === 'full' },
    ...(platform !== undefined ? { platform } : {}), log: () => {},
  });
  const scope = c.value.scope, source = c.sources.scope;
  const line = `fast-drain: mergeQueue.fastDrain.scope=${scope} (${source})${c.invalid.length ? ` · ignored invalid: ${c.invalid.join('; ')}` : ''}`;
  return { scope, source, line };
}

/** Resolve standard → platform → tool → env; injected layers keep unit probes deterministic. */
export function resolveFastDrainListingSetting({ env = process.env, tool, platform, readSettings = readDeclaredSettings } = {}) {
  let block = tool;
  if (block === undefined) {
    try { block = readSettings().settings?.mergeQueue?.fastDrain; } catch { block = undefined; }
  }
  const raw = String(env?.WE_FAST_DRAIN_LISTING ?? '').trim().toLowerCase();
  const c = cascadePolicy('mergeQueue.fastDrain', block, {
    env, standard: { listing: 'snapshot' }, envValues: { listing: raw || undefined },
    valid: { listing: (v) => v === 'snapshot' || v === 'live' },
    ...(platform !== undefined ? { platform } : {}), log: () => {},
  });
  const listing = c.value.listing, source = c.sources.listing;
  const line = `fast-drain: mergeQueue.fastDrain.listing=${listing} (${source})${c.invalid.length ? ` · ignored invalid: ${c.invalid.join('; ')}` : ''}`;
  return { listing, source, line };
}

/** Replace the live target while preserving snapshot context without mutating either input. */
export function mergeLiveTargetIntoRows(snapshotRows, targetRow, onlyPr) {
  const keepTarget = targetRow != null && (targetRow.state === undefined || targetRow.state === 'OPEN');
  let found = false;
  const rows = snapshotRows.flatMap((row) => {
    if (String(row.number) !== String(onlyPr)) return [row];
    found = true;
    return keepTarget ? [targetRow] : [];
  });
  if (keepTarget && !found) rows.push(targetRow);
  return rows;
}

export function shouldReadContextCommits({ onlyPr, scope, isTarget }) {
  return onlyPr == null || scope !== 'target' || isTarget;
}

export function filterToFastDrainTarget(prs, { onlyPr, scope, isTarget }) {
  return onlyPr != null && scope === 'target' ? prs.filter(isTarget) : prs;
}

/** Cache a found legacy manifest or a definitive absence; transient fetch misses remain retryable. */
export async function readLegacyManifestCached({ repo, num, sha, readCache, writeCache, readLegacy }) {
  const key = { repo, num, sha, kind: 'legacy-manifest' };
  const cached = readCache(key);
  if (cached !== undefined) return cached;
  const { manifest, fetchSucceeded } = await readLegacy();
  if (manifest || fetchSucceeded) writeCache({ ...key, value: manifest });
  return manifest;
}
