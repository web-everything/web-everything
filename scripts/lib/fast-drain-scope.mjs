import { setTimeout as delay } from 'node:timers/promises';
import { dirname } from 'node:path';
import { readFileSync, statSync } from 'node:fs';
import { writeJsonAtomic } from './atomic-json-file.mjs';
import { withWriteLock } from './daemon-clone-lock.mjs';
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


/** TTL is opt-in configurable; invalid bounds retain the standard 180s live-refresh fallback. */
function roundSnapshotTtl(env) {
  const raw = env.WE_FAST_DRAIN_LISTING_SNAPSHOT_TTL_SEC;
  const number = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  const valid = Number.isFinite(number) && number >= 0;
  return { seconds: valid ? number : 180, source: valid ? 'env' : 'standard' };
}

/** A round cache is advisory context only: reject incomplete, foreign or expired evidence. */
export function readFastDrainRoundSnapshot({ path, repo, now = Date.now(), env = process.env,
  read = (p) => { if (statSync(p).size > 64 * 1024 * 1024) throw new Error('snapshot too large'); return readFileSync(p, 'utf8'); },
} = {}) {
  const { seconds: ttlSec } = roundSnapshotTtl(env);
  try {
    const raw = read(path);
    if (typeof raw !== 'string' || Buffer.byteLength(raw) > 64 * 1024 * 1024) return null;
    const snap = JSON.parse(raw);
    if (snap?.repo !== repo || typeof snap.writtenAt !== 'number' || !Number.isFinite(snap.writtenAt)
      || now < snap.writtenAt || now - snap.writtenAt >= ttlSec * 1000 || !Array.isArray(snap.rows)
      || !snap.rows.every(row => Number.isInteger(row?.number) && row.number > 0
        && typeof row.headRefOid === 'string' && row.headRefOid.length > 0
        && typeof row.baseRefName === 'string' && row.baseRefName.length > 0
        && Array.isArray(row.labels) && row.labels.every(l => typeof l?.name === 'string')
        && Array.isArray(row.statusCheckRollup))) return null;
    return snap;
  } catch { return null; }
}

/** The shared writer lock waits for readers, but refuses another writer immediately. Wait for that
 * writer here so simultaneous cold children do not all fall back live. Directory identity stays stable
 * across creation of the snapshot file (realpath of an absent file can differ on symlinked temp roots).
 */
export async function withFastDrainRoundLock(path, fn, { owner, waitMs = 180_000, pollMs = 1000, sleep = delay } = {}) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const result = await withWriteLock(dirname(path), fn, { owner, lockRoot: `${path}.locks`,
      waitMs: Math.max(0, deadline - Date.now()) });
    if (result.ok || Date.now() >= deadline) return result;
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }
}

/** Populate once across concurrent catch-up children; always replace the target with a live read.
 * The shared host snapshot still seeds listLive's heavy fields. This short-lived round file saves the
 * pages/checks reads too. A failed target read propagates; it can never resurrect the cached target.
 */
export async function readFastDrainRoundListing({ path, repo, onlyPr, env = process.env, now,
  read, write = writeJsonAtomic, listLive, readTarget, defaultBranch = () => null,
  log = line => process.stderr.write(`${line}\n`),
  lock = fn => withFastDrainRoundLock(path, fn),
}) {
  const clock = () => now ?? Date.now();
  const ttl = roundSnapshotTtl(env);
  const populate = async () => {
    const snap = readFastDrainRoundSnapshot({ path, repo, env, now: clock(), read });
    if (snap) return { rows: snap.rows, hit: true };
    const rows = await listLive();
    try { write(path, { repo, writtenAt: clock(), rows, defaultBranch: defaultBranch() }); }
    catch { /* Unwritable cache costs a live listing next time; it never authorizes a cached target. */ }
    return { rows, hit: false };
  };
  // Hits do not need the population lock. Misses re-check inside it after a sibling's write.
  const snap = readFastDrainRoundSnapshot({ path, repo, env, now: clock(), read });
  let base;
  let lockFallback = false;
  if (snap) base = { rows: snap.rows, hit: true };
  else {
    let entered = false;
    let locked;
    try { locked = await lock(() => { entered = true; return populate(); }); }
    catch (error) {
      if (entered) throw error; // The live reader failed: propagate it, never retry it as a cache error.
      locked = { ok: false };
    }
    lockFallback = !locked.ok;
    base = locked.ok ? locked.value : await populate();
  }
  log(`fast-drain: ${base.hit ? 'served-from-snapshot' : 'listed-live'} (round listing; TTL=${ttl.seconds}s, source=${ttl.source}${lockFallback ? '; cache lock unavailable, live fallback' : ''})`);
  const target = await readTarget();
  if (!target || String(target.number) !== String(onlyPr) || !['OPEN', 'CLOSED', 'MERGED'].includes(target.state)) {
    throw new Error('round listing live target unreadable');
  }
  return mergeLiveTargetIntoRows(base.rows, target, onlyPr);
}
