import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { isSafeBranchName } from './daemon-self-sync.mjs';
import { restoreOverlay as restore, removeOverlay as remove, readOverlayState, appendOverlayEvent as append } from './daemon-overlays.mjs';
import { cascadePolicy, formatCascadeSourcesLine } from './policy-cascade.mjs';
import { defaultOwner, withWriteLock } from './daemon-clone-lock.mjs';

// Removal is metadata-only, but its evidence depends on HEAD staying put. Never remove unlocked.
export async function withSwapRemovalLock(root, env, fn) {
  const locked = await withWriteLock(root, fn, {
    owner: `${defaultOwner()}-overlay-removal-${randomUUID()}`,
    lockRoot: env.WE_DAEMON_CLONE_LOCK_ROOT, waitMs: 1000, pollMs: 50,
  });
  if (!locked.ok) throw new Error(`overlay-swap: clone lock unavailable (${locked.reason}); retain registrations and retry after the clone is idle`);
  return locked.value;
}

export async function removeAdoptedOverlay({ removeOverlay = remove, why = 'operator', ...options }) {
  const { root, env = process.env } = options;
  return withSwapRemovalLock(root, env, () => {
    assertSwapRemovalAdopted(options);
    return removeGuardedOverlay({ ...options, removeOverlay, env, why });
  });
}

/** Check the CURRENT marker under the removal's list mutex. Callers serialize HEAD separately. */
export function removeGuardedOverlay({ removeOverlay = remove, alert, why, ...options }) {
  const { root, ref, env = process.env } = options;
  try {
    return removeOverlay(root, ref, { env, why, beforeRemove: entry => {
      assertSwapRemovalAdopted({ ...options, readOverlays: () => [entry] });
    } });
  } catch (error) {
    if (!alert) throw error;
    alert('overlay-removal-deferred', { ref, reason: error.message });
    return { removed: false, deferred: true };
  }
}

// Preserve null exit statuses: a failed spawn must never become 'not yet adopted'.
export const overlayGitRun = (args, options) => spawnSync('git', args, { encoding: 'utf8', ...options });

export function readSwapOverlays(root, options) {
  const state = readOverlayState(root, options);
  if (state.corrupt) throw new Error('overlay-swap: unreadable registry; repair the registry before retrying');
  return state.overlays;
}

export function swapTimeout({ env = process.env, tool, log = console.error } = {}) {
  if (tool === undefined) {
    try { tool = JSON.parse(readFileSync(fileURLToPath(new URL('./daemon-rebuild-settings.json', import.meta.url)), 'utf8')).swapAfterAdopt; } catch { /* standard default */ }
  }
  const raw = env.WE_OVERLAY_SWAP_TIMEOUT_MS;
  const resolved = cascadePolicy('swapAfterAdopt', tool, {
    standard: { timeoutMs: 600_000 }, env,
    envValues: { timeoutMs: raw === undefined || raw === '' ? undefined : (/^\d+$/.test(raw) ? Number(raw) : NaN) },
    valid: { timeoutMs: v => Number.isSafeInteger(v) && v >= 0 },
  });
  log(formatCascadeSourcesLine('swapAfterAdopt', resolved));
  return { timeoutMs: resolved.value.timeoutMs, source: resolved.sources.timeoutMs };
}

function git(root, run, env, args) {
  return run(['-C', root, ...args], { env, timeout: 30_000, maxBuffer: 1024 * 1024 });
}
function ancestor(root, run, env, sha, head) {
  const result = git(root, run, env, ['merge-base', '--is-ancestor', sha, head]);
  if (result?.status !== 0 && result?.status !== 1) throw new Error('overlay-swap: git ancestry unavailable; retain registrations and retry after repairing git');
  return result.status === 0;
}
export function originTip({ root, ref, run = overlayGitRun, env = process.env }) {
  if (!isSafeBranchName(ref)) throw new TypeError('overlay-swap: unsafe ref');
  const fetched = git(root, run, env, ['fetch', '--no-tags', 'origin', `+refs/heads/${ref}:refs/remotes/origin/${ref}`]);
  if (fetched?.status !== 0) throw new Error('overlay-swap: origin fetch failed; retain registrations and retry');
  const tip = git(root, run, env, ['rev-parse', '--verify', `refs/remotes/origin/${ref}^{commit}`]);
  const sha = String(tip?.stdout ?? '').trim();
  if (tip?.status !== 0 || !/^[a-f0-9]{40}$/.test(sha)) throw new Error('overlay-swap: origin tip unavailable; retain registrations and retry');
  return sha;
}

/** Unknown evidence is a refusal, including legacy markers. */
export function assertSwapReplacementAdopted({ root, ref, readOverlays = readSwapOverlays, run = overlayGitRun, env = process.env }) {
  const entry = readOverlays(root, { env }).find(o => o.ref === ref);
  if (!entry || !Object.hasOwn(entry, 'replacedBy')) return;
  const target = entry.replacedBy;
  if (!target || (typeof target !== 'string' && typeof target !== 'object')
    || (typeof target === 'object' && !isSafeBranchName(target.ref))) {
    throw new Error('overlay-swap: invalid replacement marker; repair the registry before removing this ref');
  }
  const sha = typeof target === 'string' ? originTip({ root, ref: target, run, env }) : target.sha;
  if (!/^[a-f0-9]{40}$/.test(sha ?? '') || !ancestor(root, run, env, sha, 'HEAD')) {
    throw new Error(`overlay-swap: refusing to remove ${ref}: replacement is not adopted; wait for adoption or repair the replacement`);
  }
  return sha;
}

/** Full guard shared by manual and automatic removal; evaluate inside the list mutation. */
export function assertSwapRemovalAdopted(options) {
  const sha = assertSwapReplacementAdopted(options);
  if (!sha) return;
  const { root, ref, run = overlayGitRun, env = process.env } = options;
  const tip = originTip({ root, ref, run, env });
  if (!ancestor(root, run, env, tip, sha)) {
    throw new Error(`overlay-swap: refusing to remove ${ref}: replacement does not contain its current origin tip; update the replacement and retry`);
  }
  if (!ancestor(root, run, env, sha, 'HEAD')) {
    throw new Error('overlay-swap: replacement no longer adopted; retain registrations and retry');
  }
}

/** Timeout and pre-swap rebuild failures recover through the same per-entry, locked insertion. */
export function restoreSwapPredecessors({
  root, newRef, newSha, originalEntries, readOverlays = readSwapOverlays, addOverlay = restore,
  appendOverlayEvent = append, env = process.env, kind = 'swap-timeout-restored',
}) {
  const restored = [];
  for (const entry of originalEntries) {
    if (!readOverlays(root, { env }).some(o => o.ref === entry.ref)) {
      addOverlay(root, { ...entry, replacedBy: { ref: newRef, sha: newSha }, now: entry.addedAt }, { env });
      restored.push(entry.ref);
    }
  }
  appendOverlayEvent(root, { kind, ref: newRef, restored }, { env });
  return restored;
}

export async function swapAfterAdopt({
  root, newRef, newSha, replaces, run = overlayGitRun, removeOverlay = remove, addOverlay = restore,
  readOverlays = readSwapOverlays, appendOverlayEvent = append, now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), timeoutMs, pollMs = 1000, env = process.env,
  originalEntries, log = console.error,
}) {
  if (!isSafeBranchName(newRef) || !/^[a-f0-9]{40}$/.test(newSha) || !Array.isArray(replaces)
    || replaces.some(ref => !isSafeBranchName(ref) || ref === newRef)) throw new TypeError('overlay-swap: invalid replacement');
  const setting = timeoutMs === undefined ? swapTimeout({ env }) : { timeoutMs, source: 'argument' };
  if (!Number.isSafeInteger(setting.timeoutMs) || setting.timeoutMs < 0 || !Number.isSafeInteger(pollMs) || pollMs <= 0) throw new TypeError('overlay-swap: invalid wait bounds');
  const initial = readOverlays(root, { env });
  const originals = [...new Set(replaces)].map(ref => initial.find(o => o.ref === ref)
    ?? originalEntries?.find(o => o.ref === ref)).filter(Boolean);
  const deadline = now() + setting.timeoutMs;
  while (!ancestor(root, run, env, newSha, 'HEAD')) {
    if (now() >= deadline) {
      const restored = restoreSwapPredecessors({ root, newRef, newSha, originalEntries: originals,
        readOverlays, addOverlay, appendOverlayEvent, env });
      return { ok: false, reason: 'adoption-timeout', restored };
    }
    await sleep(Math.min(pollMs, deadline - now()));
  }
  return withSwapRemovalLock(root, env, () => {
    const removed = [], retained = [];
    if (!ancestor(root, run, env, newSha, 'HEAD')) throw new Error('overlay-swap: replacement no longer adopted; retain registrations and retry');
    for (const ref of new Set(replaces)) {
      const tip = originTip({ root, ref, run, env });
      if (!ancestor(root, run, env, tip, newSha)) {
        log(`overlay-swap: refusing to remove ${ref}: replacement does not contain its current origin tip; update the replacement and retry`);
        retained.push(ref); continue;
      }
      if (!ancestor(root, run, env, newSha, 'HEAD')) throw new Error('overlay-swap: replacement no longer adopted; retain registrations and retry');
      if (!readOverlays(root, { env }).some(o => o.ref === ref)) continue;
      const result = removeGuardedOverlay({ root, ref, run, env, removeOverlay, why: `replaced by ${newRef}`,
        alert: (kind, detail) => log(`${kind}: ${detail.ref}: ${detail.reason}`) });
      if (result.deferred) retained.push(ref);
      if (result.removed) {
        removed.push(ref);
        appendOverlayEvent(root, { kind: 'swap-removed', ref, replacedBy: newRef, newSha }, { env });
      }
    }
    return { ok: true, removed, retained };
  });
}
