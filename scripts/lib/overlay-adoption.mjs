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

/** Read-modify-write under a short mkdir mutex, so a concurrent registration is never overwritten. */
function updatePending(root, env, fs, change, { staleMs = 10000, waitMs = 3000 } = {}) {
  const lock = `${pendingAdoptionPath(root, env)}.lock`;
  fs.mkdirSync(dirname(lock), { recursive: true });
  const start = Date.now();
  for (;;) {
    try { fs.mkdirSync(lock); break; } catch (e) {
      if (e?.code !== 'EEXIST') throw e;
      let age = 0;
      try { age = Date.now() - fs.statSync(lock).mtimeMs; } catch { continue; }
      if (age > staleMs) { try { fs.rmdirSync(lock); } catch { /* raced */ } continue; }
      if (Date.now() - start > waitMs) throw new Error('adoption-pending lock busy');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try { writePending(root, env, fs, change(readPendingAdoptions(root, { env, fs }))); }
  finally { try { fs.rmdirSync(lock); } catch { /* best effort */ } }
}

/** Record that `ref`@`sha` was registered on `root` and awaits adoption. Replaces an older record for the same ref. */
export function recordPendingAdoption(root, { ref, sha, at = new Date().toISOString(), loadedBy = null }, { env = process.env, fs = nodeFs } = {}) {
  if (!FULL_SHA.test(sha || '') || typeof ref !== 'string') return false;
  try {
    updatePending(root, env, fs, (list) => [...list.filter((r) => r.ref !== ref), { ref, sha, at, loadedBy }]);
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
    const adoptedDone = []; // records whose overlay-adopted event was really written
    const overdueDone = [];
    for (const rec of pending) {
      const ageMs = now() - Date.parse(rec.at);
      let adopted = false;
      try { adopted = isAncestor(root, rec.sha); } catch { adopted = false; }
      let ev = null;
      if (adopted) ev = { kind: 'overlay-adopted', daemon, detail: { ref: rec.ref, sha: rec.sha, registeredAt: rec.at, afterMs: Number.isFinite(ageMs) ? ageMs : null } };
      else if (!rec.overdueSent && Number.isFinite(ageMs) && ageMs >= overdueMs) ev = { kind: 'overlay-adoption-overdue', daemon, detail: { ref: rec.ref, sha: rec.sha, registeredAt: rec.at, ageMs } };
      if (!ev) continue;
      // A failed write keeps the record, so the next pass tries again instead of losing the notice.
      let written = false;
      try { written = (await emit(ev)) !== false; } catch { written = false; }
      if (!written) continue;
      sent.push(ev);
      (adopted ? adoptedDone : overdueDone).push(rec);
    }
    if (sent.length) {
      // Reconcile against FRESH state under the lock: a registration made while we emitted must survive.
      const same = (list, r) => list.some((x) => x.ref === r.ref && x.sha === r.sha);
      updatePending(root, env, fs, (fresh) => fresh.filter((r) => !same(adoptedDone, r))
        .map((r) => (same(overdueDone, r) ? { ...r, overdueSent: true } : r)));
    }
  } catch { /* never affects a rebuild */ }
  return sent;
}
