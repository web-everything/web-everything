/**
 * @file lane-git-diet-cleanup.mjs
 * @description Pure rules for the one-time lane `.git` cleanup (`we:scripts/lane-git-diet.mjs`): which lanes it may
 * touch, and how to read/estimate `git count-objects -v`. The diet config itself lives in `./lane-git-diet.mjs`.
 */
import { isLeaseStale } from './lane-lease.mjs';

/** Pools whose `lane-N` dirs the cleanup may touch. `we-drain-daemon` (and any daemon clone) is never one. */
export const CLEANUP_POOLS = Object.freeze(['web-everything', 'frontierui', 'plateau-app']);

/** Decode Git's line-delimited, optionally C-quoted alternates; octal escapes encode bytes, not Unicode. */
export function parseGitAlternates(text) {
  const decode = (bytes) => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.from(bytes)).split('\0')[0];
  const escapes = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '\\': 92, '"': 34 };
  return Buffer.from(text).toString('latin1').split('\n').filter((line) => line && !line.startsWith('#')).map((line) => {
    const source = Buffer.from(line, 'latin1');
    if (source[0] !== 34) return decode(source); // Unquoted spaces and CR are literal path bytes.
    const bytes = [];
    for (let i = 1; i < source.length; i++) {
      if (source[i] === 34) return decode(bytes);
      if (source[i] !== 92) { bytes.push(source[i]); continue; }
      const escaped = String.fromCharCode(source[++i]);
      if (Object.hasOwn(escapes, escaped)) bytes.push(escapes[escaped]);
      else {
        const octal = source.subarray(i, i + 3).toString('ascii');
        if (!/^[0-3][0-7]{2}$/.test(octal)) throw new Error('unrecognized C-quoted alternate; cleanup refused');
        bytes.push(parseInt(octal, 8));
        i += 2;
      }
    }
    throw new Error('unterminated C-quoted alternate; cleanup refused');
  });
}

/**
 * May the cleanup touch this lane? Pure. Refuses anything that is not `<poolRoot>/<allowed pool>/lane-N`,
 * any path that is a symlink alias (`realDir`/`realGitDir` must be the lane's own `dir` and `dir/.git`), any lane
 * with a lease marker at all (live, reserved, or stale: the cleanup claims an ABSENT marker with O_EXCL, exactly like
 * `lane-pool trim`, so it never races an acquirer), any lane with a git lock file present (an op is mid-flight),
 * any lane another repository borrows objects from (`objects/info/alternates` pointing at it: pruning here could
 * delete objects the borrower needs), a `gc.recentObjectsHook` (gc would execute it), or GC repack filtering
 * (reachable objects could be removed or redirected outside the validated store), or a per-ref
 * `gc.<pattern>.reflogExpire[Unreachable]` (it overrides the generic keys the gc pins to `never`, so reflog-only work
 * could expire and be pruned).
 * Under a claim, pass `claimHolder`: the real `lease` must then be that holder's marker (absent, unreadable or another
 * holder's → refused as a lost claim; ours but past its TTL → refused as expired), and only then is the marker read
 * as ours rather than as a live lease.
 * @param {{dir: string, poolRoot: string, realDir?: string, realGitDir?: string, lease?: object|null, claimHolder?: string, nowMs: number,
 *   realCommonDir?: string, realObjectsDir?: string, ttlMs?: number, locks?: string[], borrowers?: string[],
 *   gcHooks?: string[], gcRepackFilters?: string[], gcReflogPatterns?: string[], configHooks?: string[], refStorage?: string[], symlinkedGitPaths?: string[]}} o  `realCommonDir`/`realObjectsDir` = resolved `git rev-parse --git-common-dir` and
 *   `<git dir>/objects`: a `commondir` file or symlinked object store would redirect the cleanup into another repo.
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function cleanupEligibility({ dir, poolRoot, realDir, realGitDir, realCommonDir, realObjectsDir, symlinkedGitPaths = [], lease = null, claimHolder, nowMs, ttlMs, locks = [], borrowers = [], gcHooks = [], gcRepackFilters = [], gcReflogPatterns = [], configHooks = [], refStorage = [] }) {
  const root = String(poolRoot || '').replace(/\/+$/, '');
  const rel = String(dir || '').startsWith(`${root}/`) ? String(dir).slice(root.length + 1) : null;
  const m = rel && /^([^/]+)\/lane-(\d+)\/?$/.exec(rel);
  if (!root || !m) return { ok: false, reason: 'not a pool lane path' };
  if (!CLEANUP_POOLS.includes(m[1])) return { ok: false, reason: `pool "${m[1]}" is not a lane pool the cleanup may touch` };
  const clean = String(dir).replace(/\/+$/, '');
  if (realDir !== undefined && realDir !== clean) return { ok: false, reason: `symlink alias (resolves to ${realDir})` };
  if (realGitDir !== undefined && realGitDir !== `${clean}/.git`) return { ok: false, reason: `.git is not the lane's own directory (resolves to ${realGitDir})` };
  if (realCommonDir !== undefined && realCommonDir !== `${clean}/.git`) return { ok: false, reason: `git common dir is redirected (${realCommonDir})` };
  if (realObjectsDir !== undefined && realObjectsDir !== `${clean}/.git/objects`) return { ok: false, reason: `object store is redirected (${realObjectsDir})` };
  // git's config/ref writers follow symlinks, so a symlinked .git/config (or refs store) would write into another repo.
  if (symlinkedGitPaths.length) return { ok: false, reason: `symlinked git paths (${symlinkedGitPaths.join(', ')})` };
  if (claimHolder !== undefined) {
    if (!claimHolder || lease?.holder !== claimHolder) return { ok: false, reason: 'claim lost (lease marker is no longer ours)' };
    // Our marker past its TTL reads as free to lane-pool, so another acquirer may already be working the lane.
    if (isLeaseStale(lease, nowMs, ttlMs)) return { ok: false, reason: 'claim expired (our lease marker is past its TTL)' };
  } else if (lease && !isLeaseStale(lease, nowMs, ttlMs)) {
    return { ok: false, reason: lease.reserved ? 'reserved lease' : `live lease (${lease.purpose || lease.holder || lease.ownerSession || 'unknown holder'})` };
  }
  else if (lease) return { ok: false, reason: 'stale lease marker present (lane-pool reclaims it; the cleanup only claims an absent marker)' };
  if (locks.length) return { ok: false, reason: `git lock present (${locks.join(', ')})` };
  if (borrowers.length) return { ok: false, reason: `objects borrowed by ${borrowers.join(', ')}` };
  if (gcHooks.length) return { ok: false, reason: 'gc.recentObjectsHook configured (gc would run it)' };
  // Pool lanes use the files ref store. `<format>://<path>` stores the refs in another repo; a bare `reftable` on a
  // files lane hides every ref, so gc/prune would treat all history as unreachable.
  const foreignRefs = refStorage.filter((v) => v !== 'files');
  if (foreignRefs.length) return { ok: false, reason: `ref store is redirected (extensions.refStorage=${foreignRefs.join(', ')})` };
  if (configHooks.length) return { ok: false, reason: `config-defined hooks configured (${configHooks.join(', ')}; core.hooksPath does not stop them)` };
  if (gcRepackFilters.length) return { ok: false, reason: `GC repack filtering configured (${gcRepackFilters.join(', ')})` };
  if (gcReflogPatterns.length) return { ok: false, reason: `per-ref reflog expiry configured (${gcReflogPatterns.join(', ')})` };
  return { ok: true };
}

/** Parse `git count-objects -v` into numbers (sizes in KiB, as git prints them). */
export function parseCountObjects(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const m = /^([a-z-]+):\s*(\d+)/.exec(line.trim());
    if (m) out[m[1]] = Number(m[2]);
  }
  return out;
}

/**
 * Dry-run projection from `count-objects -v`: loose-object storage plus garbage, i.e. what is POTENTIALLY
 * reclaimable (the ledger blobs get pruned, or repacked as deltas of each other). An estimate, not a bound:
 * reachable loose objects still cost their packed size, and pack redundancy across hundreds of packs is not counted.
 */
export function projectedFreedBytes(counts) {
  return ((counts.size || 0) + (counts['size-garbage'] || 0)) * 1024;
}

export function formatBytes(n) {
  const abs = Math.abs(n);
  if (abs >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GiB`;
  if (abs >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MiB`;
  if (abs >= 1024) return `${(n / 1024).toFixed(0)} KiB`;
  return `${n} B`;
}
