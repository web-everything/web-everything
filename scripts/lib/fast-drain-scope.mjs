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
  if (!sha) { const r = await readLegacy(); return { manifest: r.manifest, definitive: false, unreadable: !!r.unreadable }; }
  // v2: entries written under the earlier fetchSucceeded rule could hold a fallback ref's manifest.
  const key = { repo, num, sha, kind: 'legacy-manifest-v2' };
  const cached = readCache(key);
  if (cached !== undefined) return { manifest: cached, definitive: true, unreadable: false };
  const { manifest, definitive, unreadable } = await readLegacy();
  if (definitive) writeCache({ ...key, value: manifest });
  return { manifest, definitive: !!definitive, unreadable: !!unreadable };
}

const FULL_SHA = /^[0-9a-f]{40}$/;
const MANIFEST_PATH = '.lane-manifest.json';

/**
 * Read the tree-committed `.lane-manifest.json` for one PR head. `git(args)` returns stdout or throws.
 * With a full head sha, only that commit answers (fetching it when missing — the PR's own
 * `refs/pull/<n>/head` first, which origin keeps for every open PR, forks included, then `headRef`):
 * FETCH_HEAD, origin/<ref> and a same-named local branch can only name ANOTHER commit there, and FETCH_HEAD is
 * shared by every drain process in the clone. "No manifest" is definitive only when ls-tree lists the head
 * tree without the file. A head that stays unreadable (missing after both fetches, or an ls-tree/show error)
 * returns `unreadable` so the caller fails closed for this pass instead of reading it as "not a carrier".
 * Without a usable sha, nothing can be verified as the head, so it is `unreadable` too.
 * `headRef` is a gh-supplied refname and may lead with a dash, so every ref argument sits behind --end-of-options.
 * @returns {{manifest: object|null, definitive: boolean, unreadable: boolean}}
 */
export function readLegacyLocalManifestAt({ headRef, headSha, prNumber, git }) {
  const sha = typeof headSha === 'string' && FULL_SHA.test(headSha) ? headSha : null;
  const parse = (raw) => { try { const m = JSON.parse(raw); return m && m.item != null ? m : null; } catch { return null; } };
  const fetch = (ref) => {
    try { git(['fetch', '--quiet', '--end-of-options', 'origin', ref]); } catch { /* ref may be local */ }
  };
  const unreadable = { manifest: null, definitive: false, unreadable: true };
  if (sha) {
    const hasHead = () => {
      try { git(['cat-file', '-e', '--end-of-options', `${sha}^{commit}`]); return true; } catch { return false; }
    };
    if (!hasHead() && Number.isSafeInteger(prNumber) && prNumber > 0) fetch(`refs/pull/${prNumber}/head`);
    if (!hasHead() && headRef) fetch(headRef);
    if (!hasHead()) return unreadable;
    let listed;
    try { listed = git(['ls-tree', '--end-of-options', sha, '--', MANIFEST_PATH]); } catch { return unreadable; }
    if (!String(listed ?? '').trim()) return { manifest: null, definitive: true, unreadable: false };
    let raw;
    try { raw = git(['show', '--end-of-options', `${sha}:${MANIFEST_PATH}`]); } catch { return unreadable; }
    // A commit's bytes never change, so even an unparseable manifest is a final answer.
    return { manifest: parse(raw), definitive: true, unreadable: false };
  }
  // No usable head sha (the listing always supplies headRefOid, so this is not expected): no ref can be
  // verified as the head, and FETCH_HEAD may hold another process's PR — fail closed rather than guess.
  return unreadable;
}
