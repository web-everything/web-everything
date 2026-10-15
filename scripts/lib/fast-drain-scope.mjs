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

export function shouldReadContextCommits({ onlyPr, scope, isTarget }) {
  return onlyPr == null || scope !== 'target' || isTarget;
}

export function filterToFastDrainTarget(prs, { onlyPr, scope, isTarget }) {
  return onlyPr != null && scope === 'target' ? prs.filter(isTarget) : prs;
}

/**
 * Cache only an answer read from the head sha itself (`definitive`), found or absent. A fallback-ref read
 * (stale origin ref, same-named local branch, FETCH_HEAD another drain moved) is returned but stays retryable.
 */
export async function readLegacyManifestCached({ repo, num, sha, readCache, writeCache, readLegacy }) {
  if (!sha) return (await readLegacy()).manifest;
  const key = { repo, num, sha, kind: 'legacy-manifest' };
  const cached = readCache(key);
  if (cached !== undefined) return cached;
  const { manifest, definitive } = await readLegacy();
  if (definitive) writeCache({ ...key, value: manifest });
  return manifest;
}

const FULL_SHA = /^[0-9a-f]{40}$/;

/**
 * Read the tree-committed `.lane-manifest.json` for one PR head. `git(args)` returns stdout or throws.
 * The head sha is read directly once its object is local (fetching only when missing), so FETCH_HEAD,
 * which concurrent drains in one clone share, never decides it. Without a usable head object, fall back to
 * FETCH_HEAD / origin/<ref> / <ref> and mark the answer non-definitive. `headRef` is a gh-supplied refname
 * and may lead with a dash, so every ref argument sits behind --end-of-options.
 * @returns {{manifest: object|null, definitive: boolean}}
 */
export function readLegacyLocalManifestAt({ headRef, headSha, git }) {
  const sha = typeof headSha === 'string' && FULL_SHA.test(headSha) ? headSha : null;
  const readAt = (rev) => {
    try {
      const m = JSON.parse(git(['show', '--end-of-options', `${rev}:.lane-manifest.json`]));
      return m && m.item != null ? m : null;
    } catch { return null; }
  };
  const hasHead = () => {
    try { git(['cat-file', '-e', '--end-of-options', `${sha}^{commit}`]); return true; } catch { return false; }
  };
  let fetched = false;
  const fetch = () => {
    fetched = true;
    try { git(['fetch', '--quiet', '--end-of-options', 'origin', headRef]); } catch { /* ref may be local */ }
  };
  if (sha) {
    if (!hasHead()) fetch();
    if (hasHead()) return { manifest: readAt(sha), definitive: true };
  }
  if (!fetched) fetch();
  for (const rev of ['FETCH_HEAD', `origin/${headRef}`, headRef]) {
    const manifest = readAt(rev);
    if (manifest) return { manifest, definitive: false };
  }
  return { manifest: null, definitive: false };
}
