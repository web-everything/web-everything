/**
 * Pending overlay adoptions. prototype-load registers an overlay and returns at once; this file lets the
 * rebuild path (not a human, not a waiting worker) announce when the registered sha becomes an ancestor
 * of the clone HEAD (`overlay-adopted`), or that it is still not adopted after a while
 * (`overlay-adoption-overdue`, once). Every function is best-effort: failure never changes a rebuild.
 */
import { spawnSync } from 'node:child_process';
import nodeFs from 'node:fs';
import { dirname } from 'node:path';
import { overlayFilePath } from './daemon-overlays.mjs';

export const OVERLAY_ADOPTION_OVERDUE_MS = 15 * 60 * 1000;
const FULL_SHA = /^[a-f0-9]{40}$/i;
export const pendingAdoptionPath = (root, env = process.env) => `${overlayFilePath(root, env)}.adoption-pending.json`;

export function readPendingAdoptions(root, { env = process.env, fs = nodeFs } = {}) {
  try {
    const list = JSON.parse(fs.readFileSync(pendingAdoptionPath(root, env), 'utf8'));
    return Array.isArray(list) ? list.filter((r) => r && typeof r.ref === 'string' && FULL_SHA.test(r.sha || '')) : [];
  } catch { return []; }
}

function writePending(root, env, fs, list) {
  const file = pendingAdoptionPath(root, env);
  if (!list.length) { try { fs.rmSync(file, { force: true }); } catch { /* best effort */ } return; }
  fs.mkdirSync(dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(list)}\n`, 'utf8');
}

/** Record that `ref`@`sha` was registered on `root` and awaits adoption. Replaces an older record for the same ref. */
export function recordPendingAdoption(root, { ref, sha, at = new Date().toISOString(), loadedBy = null }, { env = process.env, fs = nodeFs } = {}) {
  if (!FULL_SHA.test(sha || '') || typeof ref !== 'string') return false;
  try {
    const rest = readPendingAdoptions(root, { env, fs }).filter((r) => r.ref !== ref);
    writePending(root, env, fs, [...rest, { ref, sha, at, loadedBy }]);
    return true;
  } catch { return false; }
}

const defaultIsAncestor = (root, sha) =>
  spawnSync('git', ['-C', root, 'merge-base', '--is-ancestor', sha, 'HEAD'], { encoding: 'utf8', timeout: 20000 }).status === 0;

/**
 * Called from the rebuild path after every pass. Emits overlay-adopted when a pending sha is an ancestor of
 * HEAD (and forgets it), overlay-adoption-overdue once when it is older than overdueMs. Returns the events.
 */
export async function checkPendingAdoptions({ root, env = process.env, fs = nodeFs, emit, daemon, now = () => Date.now(),
  overdueMs = OVERLAY_ADOPTION_OVERDUE_MS, isAncestor = defaultIsAncestor } = {}) {
  const sent = [];
  try {
    const pending = readPendingAdoptions(root, { env, fs });
    if (!pending.length) return sent;
    const keep = [];
    for (const rec of pending) {
      const ageMs = now() - Date.parse(rec.at);
      let adopted = false;
      try { adopted = isAncestor(root, rec.sha); } catch { adopted = false; }
      if (adopted) {
        const ev = { kind: 'overlay-adopted', daemon, detail: { ref: rec.ref, sha: rec.sha, registeredAt: rec.at, afterMs: Number.isFinite(ageMs) ? ageMs : null } };
        sent.push(ev); await emit(ev); continue;
      }
      if (!rec.overdueSent && Number.isFinite(ageMs) && ageMs >= overdueMs) {
        const ev = { kind: 'overlay-adoption-overdue', daemon, detail: { ref: rec.ref, sha: rec.sha, registeredAt: rec.at, ageMs } };
        sent.push(ev); await emit(ev); keep.push({ ...rec, overdueSent: true }); continue;
      }
      keep.push(rec);
    }
    if (sent.length) writePending(root, env, fs, keep);
  } catch { /* never affects a rebuild */ }
  return sent;
}
