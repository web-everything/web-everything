import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isSafeBranchName } from './daemon-self-sync.mjs';
import { addOverlay as add, removeOverlay as remove, readOverlayState, appendOverlayEvent as append } from './daemon-overlays.mjs';
import { cascadePolicy, formatCascadeSourcesLine } from './policy-cascade.mjs';

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

/** Shared by manual removal: unknown evidence is a refusal, including legacy markers. */
export function assertSwapRemovalAdopted({ root, ref, readOverlays = readSwapOverlays, run = overlayGitRun, env = process.env }) {
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
}

export async function swapAfterAdopt({
  root, newRef, newSha, replaces, run = overlayGitRun, removeOverlay = remove, addOverlay = add,
  readOverlays = readSwapOverlays, appendOverlayEvent = append, now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), timeoutMs, pollMs = 1000, env = process.env,
  originalEntries,
}) {
  if (!isSafeBranchName(newRef) || !/^[a-f0-9]{40}$/.test(newSha) || !Array.isArray(replaces)
    || replaces.some(ref => !isSafeBranchName(ref) || ref === newRef)) throw new TypeError('overlay-swap: invalid replacement');
  const setting = timeoutMs === undefined ? swapTimeout({ env }) : { timeoutMs, source: 'argument' };
  if (!Number.isSafeInteger(setting.timeoutMs) || setting.timeoutMs < 0 || !Number.isSafeInteger(pollMs) || pollMs <= 0) throw new TypeError('overlay-swap: invalid wait bounds');
  const initial = readOverlays(root, { env });
  const originals = new Map(replaces.map(ref => [ref, { ...(originalEntries?.find(o => o.ref === ref) ?? initial.find(o => o.ref === ref)), ref }]));
  const deadline = now() + setting.timeoutMs;
  while (!ancestor(root, run, env, newSha, 'HEAD')) {
    if (now() >= deadline) {
      const restored = [];
      for (const ref of new Set(replaces)) {
        if (!readOverlays(root, { env }).some(o => o.ref === ref)) {
          const entry = originals.get(ref);
          addOverlay(root, { ...entry, now: entry.addedAt }, { env });
          restored.push(ref);
        }
      }
      appendOverlayEvent(root, { kind: 'swap-timeout-restored', ref: newRef, restored }, { env });
      return { ok: false, reason: 'adoption-timeout', restored };
    }
    await sleep(Math.min(pollMs, deadline - now()));
  }
  const removed = [], retained = [];
  for (const ref of new Set(replaces)) {
    const tip = originTip({ root, ref, run, env });
    if (!ancestor(root, run, env, tip, newSha)) { retained.push(ref); continue; }
    if (!ancestor(root, run, env, newSha, 'HEAD')) throw new Error('overlay-swap: replacement no longer adopted; retain registrations and retry');
    if (!readOverlays(root, { env }).some(o => o.ref === ref)) continue;
    if (removeOverlay(root, ref, { env, why: `replaced by ${newRef}` }).removed) {
      removed.push(ref);
      appendOverlayEvent(root, { kind: 'swap-removed', ref, replacedBy: newRef, newSha }, { env });
    }
  }
  return { ok: true, removed, retained };
}
