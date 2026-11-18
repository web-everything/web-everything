/** Shared registration drop protocol. No rebuild/CLI imports: safe for preparation and main-sync. */
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, statSync, rmSync, renameSync } from 'node:fs';
import { restoreOverlayRegistration, readOverlays, appendOverlayEvent, overlayFilePath } from './daemon-overlays.mjs';

export function remoteTip({ root, ref, env = process.env, run = spawnSync }) {
  const opts = { cwd: root, encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024, env: { ...env, GIT_OPTIONAL_LOCKS: '0' } };
  const url = run('git', ['-C', root, 'remote', 'get-url', 'origin'], opts);
  if (url?.status !== 0) return undefined;
  const ls = run('git', ['ls-remote', String(url.stdout).trim(), `refs/heads/${ref}`], opts);
  if (ls?.status !== 0) return undefined;
  const match = new RegExp(`^([0-9a-f]{40})\\s+refs/heads/${ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm').exec(String(ls.stdout ?? ''));
  return match ? match[1] : null;
}

export function restoreRegistration(root, entry, env) {
  return restoreOverlayRegistration(root, entry, { env });
}

// ── durable drop intents (R310 audit) ─────────────────────────────────────────────────────────────────────────
// A retire/replace writes its intent BEFORE dropping a registration and clears it only after the post-drop tip
// check. A process killed in between leaves the intent behind, and the next add/retire/replace/recover-drops run
// settles it FIRST, under the add-guard lock: tip unchanged -> the drop stands; tip moved or unreadable -> the
// registration is restored. Because every guarded add settles intents before its own check, no add is ever admitted
// against a list that is missing an unsettled registration, so a restore returns the list to its pre-drop state.
// No `.json` suffix: `pruneStaleOverlayRecords` deletes every clone-less `*.json` in the overlay dir.
const pendingPath = (root, env) => `${overlayFilePath(root, env)}.drop-pending`;
export function readPendingDrops(root, env = process.env) {
  try {
    const parsed = JSON.parse(readFileSync(pendingPath(root, env), 'utf8'));
    if (!Array.isArray(parsed?.pending)) throw new Error('bad shape');
    return parsed.pending;
  } catch (e) {
    if (e?.code === 'ENOENT') return [];
    throw new Error(`drop-intent record ${pendingPath(root, env)} is unreadable — refusing to drop anything until it is fixed`);
  }
}
function writePendingDrops(root, env, pending) {
  const file = pendingPath(root, env);
  if (!pending.length) { rmSync(file, { force: true }); return; }
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify({ pending }, null, 2), 'utf8');
  renameSync(tmp, file);
}
export const addPending = (root, env, record) => writePendingDrops(root, env, [...readPendingDrops(root, env).filter((p) => p.ref !== record.ref), record]);
export const clearPending = (root, env, ref) => writePendingDrops(root, env, readPendingDrops(root, env).filter((p) => p.ref !== ref));

/** Settle every drop intent left by an interrupted retire/replace. Call only under the add-guard lock. */
export function settlePendingDrops({ root, env = process.env, by = null, deps = {} }) {
  const tip = deps.tip ?? ((r) => remoteTip({ root, ref: r, env }));
  const settled = [];
  for (const record of readPendingDrops(root, env)) {
    const list = readOverlays(root, { env });
    if (list.some((o) => o?.ref === record.ref)) { clearPending(root, env, record.ref); settled.push({ ref: record.ref, outcome: 'still-registered' }); continue; }
    const tipNow = tip(record.ref);
    const newNow = record.newRef ? tip(record.newRef) : undefined;
    // A squash-merged retire was proved on a DELETED branch: only a still-deleted branch confirms it.
    if ((record.refGone === true ? tipNow === null : tipNow === record.tip) && (!record.newRef || newNow === record.newTip)) {
      clearPending(root, env, record.ref);
      appendOverlayEvent(root, { ...(record.kind === 'prune' ? { kind: 'overlay-pruned', ...record.event } : { kind: record.kind === 'replace' ? 'replaced' : 'auto-retired' }), ref: record.ref, by, tip: record.tip, recovered: true }, { env });
      settled.push({ ref: record.ref, outcome: 'drop-confirmed' });
      continue;
    }
    // Not proved: put it back. It was registered when the drop began, and no guarded add ran since (see above).
    restoreRegistration(root, record.entry, env);
    clearPending(root, env, record.ref);
    appendOverlayEvent(root, { kind: 'drop-reverted', ref: record.ref, by, tip: record.tip, tipNow: tipNow ?? null, recovered: true }, { env });
    settled.push({ ref: record.ref, outcome: 'restored' });
  }
  return settled;
}

// ── the add-guard lock — serializes check-then-register across concurrent `add`s (PR #2827 review) ──────────
// A `mkdir` mutex next to the overlay state file, SEPARATE from the list's own millisecond mutex
// (`daemon-overlays.mjs#withListLock`). Pruning shares this guard in no-wait mode; retirement and
// guarded additions may wait and recover stale owners. The holder's `owner` file carries a unique `<pid>:<uuid>` token,
// written temp-file + rename so a reader never sees a partial one.
//
// A gone holder (dead pid, older than ADD_GUARD_STALE_MS, or an owner-less dir older than 5s) is recovered
// under a SECOND mkdir mutex, `<lockDir>.recover`: while the dead dir exists no one can `mkdir` the lock, so
// exclusivity is never released mid-recovery. The recoverer removes the dir only if token, inode and mtime are
// all still what it inspected — a fresh holder (whose owner write changes token and mtime) is never removed.
// Named, accepted residual: a recoverer paused between its re-check and its rename for > RECOVER_STALE_MS while
// a replacement lock lands in that gap; closing it needs a true atomic compare-and-remove primitive.
const ADD_GUARD_STALE_MS = 10 * 60_000;
const ADD_GUARD_OWNERLESS_MS = 5_000;
const ADD_GUARD_RECOVER_STALE_MS = 30_000;
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

function readAddGuardOwner(lockDir) {
  try { return readFileSync(join(lockDir, 'owner'), 'utf8').trim(); } catch { return ''; /* not written yet, or gone */ }
}

/** Write `token` as `dir`'s owner atomically (temp file + rename). */
function writeAddGuardOwner(dir, token) {
  const tmp = join(dir, `owner.tmp-${randomUUID()}`);
  writeFileSync(tmp, token);
  renameSync(tmp, join(dir, 'owner'));
}

/** The pid prefix of an owner token; a legacy bare-pid owner parses too. NaN when unparseable. */
function addGuardOwnerPid(token) {
  const m = /^(\d+)(?::.*)?$/.exec(token);
  return m ? Number(m[1]) : NaN;
}

/** Snapshot of the lock dir — `{token, ino, mtimeMs, gone}` — or `null` once it is released. `gone` is true for a
 *  holder that is dead or stale; a fresh owner-less dir (a live holder between `mkdir` and its owner write) is NOT gone. */
function inspectAddGuardLock(lockDir) {
  let st;
  try { st = statSync(lockDir); } catch { return null; }
  const token = readAddGuardOwner(lockDir);
  const ageMs = Date.now() - st.mtimeMs;
  const snap = { token, ino: st.ino, mtimeMs: st.mtimeMs, gone: false };
  if (ageMs > ADD_GUARD_STALE_MS) { snap.gone = true; return snap; }
  const pid = addGuardOwnerPid(token);
  if (!token || !Number.isInteger(pid) || pid <= 0) { snap.gone = ageMs > ADD_GUARD_OWNERLESS_MS; return snap; }
  try { process.kill(pid, 0); } catch (e) { snap.gone = e.code === 'ESRCH'; }
  return snap;
}

/** Take the `.recover` mutex (breaking one older than ADD_GUARD_RECOVER_STALE_MS) — returns our token, or `null`. */
function takeRecoverMutex(recoverDir) {
  for (let tries = 0; tries < 2; tries++) {
    try {
      mkdirSync(recoverDir);
      const token = `${process.pid}:${randomUUID()}`;
      writeAddGuardOwner(recoverDir, token);
      return token;
    } catch (e) {
      if (!e || e.code !== 'EEXIST') throw e;
      let ageMs;
      try { ageMs = Date.now() - statSync(recoverDir).mtimeMs; } catch { continue; /* released meanwhile */ }
      if (ageMs <= ADD_GUARD_RECOVER_STALE_MS) return null;
      const aside = `${recoverDir}.stale-${process.pid}-${randomUUID()}`;
      try { renameSync(recoverDir, aside); } catch { return null; /* someone else broke it first */ }
      rmSync(aside, { recursive: true, force: true });
    }
  }
  return null;
}

/** Remove the gone lock `seen` — serialised behind `.recover`, and only if it is still exactly what was inspected. */
async function recoverAddGuardLock(lockDir, seen, hooks) {
  const recoverDir = `${lockDir}.recover`;
  const mine = takeRecoverMutex(recoverDir);
  if (!mine) return false;
  try {
    await hooks.onPhase?.('removing', { lockDir, seen });
    const now = inspectAddGuardLock(lockDir);
    if (now && now.gone && now.token === seen.token && now.ino === seen.ino && now.mtimeMs === seen.mtimeMs) {
      const aside = `${lockDir}.stale-${process.pid}-${randomUUID()}`;
      try { renameSync(lockDir, aside); rmSync(aside, { recursive: true, force: true }); } catch { /* gone already */ }
    }
  } finally {
    // Only our own mutex — a paused recoverer's was broken as stale and may now belong to someone else.
    if (readAddGuardOwner(recoverDir) === mine) rmSync(recoverDir, { recursive: true, force: true });
  }
  await hooks.onPhase?.('removed', { lockDir, seen });
  return true;
}

/** `hooks.onPhase?.(phase, ctx)` (awaited) is a test seam — phases `attempt`, `inspected`, `removing`, `removed`.
 *  Production callers pass none. */
async function withWaitingAddGuardLock(root, env, fn, hooks = {}) {
  const lockDir = `${overlayFilePath(root, env)}.add-guard.lock`;
  mkdirSync(dirname(lockDir), { recursive: true });
  const waitMs = Number(env.WE_DAEMON_OVERLAY_ADD_GUARD_WAIT_MS) > 0 ? Number(env.WE_DAEMON_OVERLAY_ADD_GUARD_WAIT_MS) : 180_000;
  const deadline = Date.now() + waitMs;
  const token = `${process.pid}:${randomUUID()}`;
  for (;;) {
    await hooks.onPhase?.('attempt', { lockDir });
    try {
      mkdirSync(lockDir);
    } catch (e) {
      if (!e || e.code !== 'EEXIST') throw e;
      const seen = inspectAddGuardLock(lockDir);
      if (!seen) continue; // released meanwhile
      if (seen.gone) {
        await hooks.onPhase?.('inspected', { lockDir, seen });
        if (await recoverAddGuardLock(lockDir, seen, hooks)) continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`add-guard lock ${lockDir} still held after ${waitMs}ms — another \`add\` is checking; retry`);
      }
      await sleep(seen.gone ? 50 : 100);
      continue;
    }
    try { writeAddGuardOwner(lockDir, token); } catch (e) { rmSync(lockDir, { recursive: true, force: true }); throw e; }
    break;
  }
  try {
    return await fn();
  } finally {
    // Release only our own lock — if it was broken as stale meanwhile, the dir now belongs to someone else.
    if (readAddGuardOwner(lockDir) === token) rmSync(lockDir, { recursive: true, force: true });
  }
}

/** Synchronous callers fail closed on a busy guard; waiting callers retain recovery semantics. */
export function withAddGuardLock(root, env, fn, hooks = {}) {
  if (!hooks.noWait) return withWaitingAddGuardLock(root, env, fn, hooks);
  const lockDir = `${overlayFilePath(root, env)}.add-guard.lock`;
  mkdirSync(dirname(lockDir), { recursive: true });
  mkdirSync(lockDir);
  const token = `${process.pid}:${randomUUID()}`;
  try {
    writeAddGuardOwner(lockDir, token);
    return fn();
  } finally {
    if (readAddGuardOwner(lockDir) === token) rmSync(lockDir, { recursive: true, force: true });
  }
}
