/**
 * @file lane-git-diet.mjs
 * @description Keep lane clones' `.git` small: stop the default fetch from pulling `ops/*` transport branches,
 * keep fetched objects packed, and plan the one-time cleanup of lanes that already bloated.
 *
 * WHY (git review 2026-10-21): every lane's default refspec `+refs/heads/*` also fetched `ops/review-requests`,
 * the ~10 MB verdict ledger that gets a new commit every few minutes. A small fetch is unpacked into loose
 * objects (git's default `fetch.unpackLimit` is 100), so each new ledger tip wrote a ~9 MB loose blob into
 * every lane: lane-5 held 2.37 GiB of loose objects and the 104 lanes' `.git` dirs totalled ~35 GB.
 *
 * THE FIX, per lane (local config only):
 *   - `remote.origin.fetch` keeps `+refs/heads/*:refs/remotes/origin/*` and gains the negative refspec
 *     `^refs/heads/ops/*` (git >= 2.29). A plain `git fetch origin` no longer touches `ops/*`.
 *   - `fetch.unpackLimit=1` + `transfer.unpackLimit=1`: a fetch always lands as one pack, never loose blobs.
 *
 * READERS ARE UNAFFECTED. Every in-repo reader of an `ops/*` ref fetches it explicitly with a full refspec
 * (`+refs/heads/ops/x:refs/remotes/origin/ops/x`, see `trackingRefspec` in `./git-transport-branch.mjs`).
 * A configured negative refspec does not filter an explicit command-line refspec, so those fetches still
 * update `origin/ops/x` (proven in `__tests__/lane-git-diet.test.mjs` against real repos). The inventory of
 * readers lives in {@link OPS_REF_READERS} and a test keeps it complete.
 *
 * Pure planning lives here; the CLI that touches disk is `we:scripts/lane-git-diet.mjs`.
 */
import { isLeaseStale } from './lane-lease.mjs';

export const LANE_DEFAULT_FETCH = '+refs/heads/*:refs/remotes/origin/*';
export const LANE_OPS_NEGATIVE_FETCH = '^refs/heads/ops/*';
/** Local config keys a diet lane must carry, with their values. */
export const LANE_DIET_KV = Object.freeze({ 'fetch.unpackLimit': '1', 'transfer.unpackLimit': '1' });

/**
 * Every source file that reads an `ops/*` ref inside a checkout, and how it gets the ref. Each one fetches the
 * ref explicitly by name, so the negative refspec cannot starve it. A test scans `scripts/` and fails when a
 * new reader of `origin/ops/*` appears that is not listed here.
 */
export const OPS_REF_READERS = Object.freeze([
  { file: 'scripts/lib/git-transport-branch.mjs', refs: 'ops/review-requests, ops/pr-views, ops/quarantine, ops/red-main-freeze (any transport)', how: 'trackingRefspec(branch) before ls-tree/show/worktree add' },
  { file: 'scripts/lib/pr-view-transport.mjs', refs: 'ops/pr-views', how: 'fetchTransportArgv(): +refs/heads/ops/pr-views:refs/remotes/origin/ops/pr-views' },
  { file: 'scripts/operations/stage-pr-view-io.mjs', refs: 'ops/pr-views', how: '+refs/heads/${ref}:refs/remotes/origin/${ref} before rev-parse' },
  { file: 'scripts/operations/record-verdict-io.mjs', refs: 'ops/review-requests (+ board genesis source)', how: 'trackingRefspec(sourceBranch) / stageOnTransportBranch' },
  { file: 'scripts/operations/handoff-home.mjs', refs: 'ops/handoff', how: 'trackingRefspec(HANDOFF_BRANCH); runs in its own ~/.claude checkout, not a lane' },
  { file: 'scripts/ci/quarantine-skip.mjs', refs: 'ops/quarantine', how: '+refs/heads/${base}:refs/remotes/origin/${base} (CI job)' },
  // Delegators: they never name a tracking ref themselves; every read goes through readFromTransportBranch.
  { file: 'scripts/lib/verdict-ledger-io.mjs', refs: 'ops/review-requests', how: 'readFromTransportBranch' },
  { file: 'scripts/lib/review-precedents-io.mjs', refs: 'ops/review-requests', how: 'readFromTransportBranch' },
  { file: 'scripts/lib/red-main-quarantine-io.mjs', refs: 'ops/quarantine', how: 'readFromTransportBranch' },
  { file: 'scripts/lib/red-main-freeze-shared.mjs', refs: 'ops/red-main-freeze', how: 'readFromTransportBranch' },
  { file: 'scripts/merge-gate-check.mjs', refs: 'ops/red-main-freeze', how: 'readFromTransportBranch (via red-main-freeze-shared)' },
]);

/**
 * The `git config` argv lists that bring a lane's local config to the diet shape. Pure and idempotent: an
 * already-diet lane yields `[]`.
 * @param {{fetchValues?: string[], kv?: Record<string, string|undefined>}} current
 *   `fetchValues` = `git config --get-all remote.origin.fetch`; `kv` = current local values of {@link LANE_DIET_KV}.
 * @returns {string[][]} argv arrays for `git` (each starts with `config`)
 */
export function laneDietConfigOps({ fetchValues = [], kv = {} } = {}) {
  const ops = [];
  const values = fetchValues.map((v) => String(v).trim()).filter(Boolean);
  // A clone with NO fetch refspec is not a shape we own; restore the standard one first so the negative
  // refspec never stands alone (a negative-only config fetches nothing and git rejects it).
  if (!values.includes(LANE_DEFAULT_FETCH) && !values.some((v) => !v.startsWith('^'))) {
    ops.push(['config', '--local', '--add', 'remote.origin.fetch', LANE_DEFAULT_FETCH]);
  }
  if (!values.includes(LANE_OPS_NEGATIVE_FETCH)) {
    ops.push(['config', '--local', '--add', 'remote.origin.fetch', LANE_OPS_NEGATIVE_FETCH]);
  }
  for (const [key, want] of Object.entries(LANE_DIET_KV)) {
    if (kv[key] !== want) ops.push(['config', '--local', '--replace-all', key, want]);
  }
  return ops;
}

/**
 * Read a lane's current config and apply {@link laneDietConfigOps}. `run(args)` runs git in the lane and
 * returns stdout. Only git's "key not set" answer (exit status 1) reads as unset; any other failure (a timeout,
 * a locked config) propagates, so a half-read config can never cause duplicate refspecs.
 * @returns {string[][]} the ops applied
 */
export function applyLaneDietConfig(run) {
  const read = (args) => {
    try { return String(run(args) ?? ''); } catch (e) { if (e && e.status === 1) return ''; throw e; }
  };
  const fetchValues = read(['config', '--local', '--get-all', 'remote.origin.fetch']).split('\n');
  const kv = {};
  for (const key of Object.keys(LANE_DIET_KV)) {
    const v = read(['config', '--local', '--get-all', key]).trim();
    if (v) kv[key] = v; // several values read as "not exactly the diet value" → replaced below
  }
  const ops = laneDietConfigOps({ fetchValues, kv });
  for (const op of ops) run(op);
  return ops;
}

/** Pools whose `lane-N` dirs the cleanup may touch. `we-drain-daemon` (and any daemon clone) is never one. */
export const CLEANUP_POOLS = Object.freeze(['web-everything', 'frontierui', 'plateau-app']);

/**
 * May the cleanup touch this lane? Pure. Refuses anything that is not `<poolRoot>/<allowed pool>/lane-N`,
 * any path that is a symlink alias (`realDir`/`realGitDir` must be the lane's own `dir` and `dir/.git`), any lane
 * with a lease marker at all (live, reserved, or stale: the cleanup claims an ABSENT marker with O_EXCL, exactly like
 * `lane-pool trim`, so it never races an acquirer), any lane with a git lock file present (an op is mid-flight),
 * any lane another repository borrows objects from (`objects/info/alternates` pointing at it: pruning here could
 * delete objects the borrower needs), and any lane with a `gc.recentObjectsHook` (gc would execute it).
 * @param {{dir: string, poolRoot: string, realDir?: string, realGitDir?: string, lease?: object|null, nowMs: number,
 *   realCommonDir?: string, realObjectsDir?: string, ttlMs?: number, locks?: string[], borrowers?: string[],
 *   gcHooks?: string[]}} o  `realCommonDir`/`realObjectsDir` = resolved `git rev-parse --git-common-dir` and
 *   `<git dir>/objects`: a `commondir` file or symlinked object store would redirect the cleanup into another repo.
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function cleanupEligibility({ dir, poolRoot, realDir, realGitDir, realCommonDir, realObjectsDir, lease = null, nowMs, ttlMs, locks = [], borrowers = [], gcHooks = [] }) {
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
  if (lease && !isLeaseStale(lease, nowMs, ttlMs)) {
    return { ok: false, reason: lease.reserved ? 'reserved lease' : `live lease (${lease.purpose || lease.holder || lease.ownerSession || 'unknown holder'})` };
  }
  if (lease) return { ok: false, reason: 'stale lease marker present (lane-pool reclaims it; the cleanup only claims an absent marker)' };
  if (locks.length) return { ok: false, reason: `git lock present (${locks.join(', ')})` };
  if (borrowers.length) return { ok: false, reason: `objects borrowed by ${borrowers.join(', ')}` };
  if (gcHooks.length) return { ok: false, reason: 'gc.recentObjectsHook configured (gc would run it)' };
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
